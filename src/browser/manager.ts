import type { Browser, BrowserContext, Page } from 'playwright-core';
import { findChromePath } from '../doctor.js';
import { platform } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export type BrowserStatus = 'running' | 'idle' | 'stopped';
export type BrowserMode = 'attach' | 'launch';
export type LoginStatus = 'idle' | 'opening' | 'waiting_for_user' | 'success' | 'failed';

export interface LoginState {
  providerId: string | null;
  status: LoginStatus;
  message: string;
  startedAt: number | null;
}

export interface BrowserManagerOptions {
  profileDir: string;
  startupTimeout: number;
  idleShutdown: number;
  loginTimeout: number;
  cdpUrl?: string;        // e.g. "http://127.0.0.1:9222"
  mode?: BrowserMode;     // "attach" (default) | "launch"
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private _status: BrowserStatus = 'stopped';
  private _mode: BrowserMode;
  private _loginStates = new Map<string, LoginState>();
  private _loginPages = new Map<string, Page>();
  private domainPages = new Map<string, Page[]>();
  private busyPages = new Set<Page>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: BrowserManagerOptions) {
    this._mode = opts.mode ?? 'attach';
  }

  private isContextAlive(): boolean {
    if (!this.context) return false;
    if (this.browser && !this.browser.isConnected()) return false;
    try {
      this.context.pages();
      return true;
    } catch {
      return false;
    }
  }

  private cleanupStaleState(): void {
    this.domainPages.clear();
    this.busyPages.clear();
    this._loginPages.clear();
    this.browser = null;
    this.context = null;
    this._status = 'stopped';
  }

  /**
   * Auto-launch Chrome with CDP debugging port if Chrome was closed or not started.
   */
  async autoLaunchChromeCDP(): Promise<boolean> {
    const chromePath = this.findChrome();
    if (!chromePath) return false;

    const cdpUrl = this.opts.cdpUrl ?? 'http://127.0.0.1:9222';
    const port = parseInt(new URL(cdpUrl).port, 10) || 9222;
    const profileDir = this.opts.profileDir;

    try {
      mkdirSync(profileDir, { recursive: true });
      const os = platform();
      if (os === 'darwin') {
        execSync(`"${chromePath}" --remote-debugging-port=${port} --user-data-dir="${profileDir}" --no-first-run --no-default-browser-check &>/dev/null &`, { shell: '/bin/zsh' });
      } else if (os === 'win32') {
        const child = spawn(chromePath, [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profileDir}`,
          '--no-first-run',
          '--no-default-browser-check',
        ], { detached: true, stdio: 'ignore' });
        child.unref();
      } else {
        execSync(`"${chromePath}" --remote-debugging-port=${port} --user-data-dir="${profileDir}" --no-first-run --no-default-browser-check &>/dev/null &`, { shell: '/bin/bash' });
      }

      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await this.detectCDP(cdpUrl)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Connect to browser. In attach mode, connects to existing Chrome via CDP,
   * or auto-launches a new Chrome instance if Chrome was closed.
   * In launch mode, launches a new persistent context.
   */
  async ensureBrowser(): Promise<BrowserContext> {
    if (this.isContextAlive() && this.context) {
      this.resetIdleTimer();
      return this.context;
    }

    // Previous browser was closed or died
    this.cleanupStaleState();

    const { chromium } = await import('playwright-core');

    if (this._mode === 'attach') {
      const cdpUrl = this.opts.cdpUrl ?? 'http://127.0.0.1:9222';
      let cdpReady = await this.detectCDP(cdpUrl);

      if (!cdpReady) {
        // Auto-relaunch Chrome with CDP
        cdpReady = await this.autoLaunchChromeCDP();
      }

      if (cdpReady) {
        try {
          this.browser = await chromium.connectOverCDP(cdpUrl, {
            timeout: this.opts.startupTimeout,
          });
          this.browser.on('disconnected', () => {
            this.cleanupStaleState();
          });
          const contexts = this.browser.contexts();
          this.context = contexts[0] ?? await this.browser.newContext();
          this.context.on('close', () => {
            this.cleanupStaleState();
          });
          this._status = 'running';
          this.resetIdleTimer();
          return this.context;
        } catch {
          this.cleanupStaleState();
        }
      }

      // If still cannot connect, provide helpful error
      throw new Error(
        `Cannot connect to Chrome at ${cdpUrl}.\n\n` +
        `Chrome was closed or remote debugging is unavailable.\n` +
        `Please make sure Chrome is started with remote debugging:\n\n` +
        this.getChromeStartCommand() +
        `\n\nOr switch to launch mode: web-model-bridge --browser-mode launch`
      );
    }

    // Launch mode — start new Chrome with persistent profile
    const executablePath = this.findChrome();
    if (!executablePath) {
      throw new Error('Chrome not found. Install Google Chrome first.');
    }

    this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
      headless: true,
      executablePath,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
      ],
      timeout: this.opts.startupTimeout,
    });

    this.context.on('close', () => {
      this.cleanupStaleState();
    });

    this._status = 'running';
    this.resetIdleTimer();
    return this.context;
  }

  /**
   * Release a page back to the pool so subsequent requests can reuse it.
   */
  releasePage(page: Page): void {
    this.busyPages.delete(page);
  }

  /**
   * Get an available page navigated to the target origin.
   * If an existing page for this origin is busy, creates an additional page
   * so multiple concurrent requests to the same or different models run seamlessly!
   */
  async getPageForOrigin(origin: string): Promise<Page> {
    const ctx = await this.ensureBrowser();

    let pages = this.domainPages.get(origin) || [];
    pages = pages.filter(p => !p.isClosed());
    this.domainPages.set(origin, pages);

    // Look for an idle page not currently locked by an ongoing generation
    let page = pages.find(p => !this.busyPages.has(p));

    if (!page) {
      // First check if an existing open tab in the browser context is already on this origin
      const openPages = ctx.pages().filter(p => !p.isClosed());
      const existingMatch = openPages.find(p => {
        try {
          const u = p.url();
          const targetHost = new URL(origin).hostname.replace(/^www\./, '').toLowerCase();
          const pageHost = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
          const hostMatch = pageHost === targetHost || pageHost.endsWith('.' + targetHost) || targetHost.endsWith('.' + pageHost);
          return (u.startsWith(origin) || hostMatch) && !this.busyPages.has(p) && !Array.from(this._loginPages.values()).includes(p);
        } catch {
          return false;
        }
      });

      if (existingMatch) {
        page = existingMatch;
        pages.push(page);
        this.domainPages.set(origin, pages);
      } else {
        try {
          page = await ctx.newPage();
        } catch {
          // If context closed while creating page, clean and recreate
          this.cleanupStaleState();
          const freshCtx = await this.ensureBrowser();
          page = await freshCtx.newPage();
        }

        try {
          await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 25000 });
        } catch {
          try {
            await page.goto(origin + '/', { waitUntil: 'commit', timeout: 10000 });
          } catch {
            // Page is now on the right domain even if load didn't fully complete
          }
        }
        pages.push(page);
        this.domainPages.set(origin, pages);
      }
    }

    this.busyPages.add(page);

    page.once('close', () => {
      this.busyPages.delete(page!);
    });

    (page as any).release = () => {
      this.releasePage(page);
    };

    await page.bringToFront().catch(() => {});
    return page;
  }

  /**
   * Execute arbitrary code in browser context on a specific domain.
   */
  async evaluateOnDomain<T>(origin: string, fn: string, args?: unknown): Promise<T> {
    const page = await this.getPageForOrigin(origin);
    try {
      return await (page.evaluate(fn as any, args as any) as Promise<T>);
    } finally {
      this.releasePage(page);
    }
  }

  /**
   * Execute fetch in browser context. Navigates to the target domain first
   * so that cookies are available and CORS is not an issue.
   */
  async fetchInBrowser(url: string, init: RequestInit): Promise<Response> {
    const targetOrigin = new URL(url).origin;
    const page = await this.getPageForOrigin(targetOrigin);

    try {
      const result = await page.evaluate(
        async ([fetchUrl, fetchInit]: [string, { method?: string; headers?: Record<string, string>; body?: string }]) => {
          const res = await fetch(fetchUrl, {
            method: fetchInit.method || 'GET',
            headers: fetchInit.headers,
            body: fetchInit.body,
            credentials: 'include',
          });

          const headers: Record<string, string> = {};
          res.headers.forEach((v: string, k: string) => { headers[k] = v; });
          const text = await res.text();
          return { status: res.status, headers, body: text, ok: res.ok };
        },
        [url, {
          method: init.method,
          headers: init.headers as Record<string, string>,
          body: init.body as string,
        }] as [string, { method?: string; headers?: Record<string, string>; body?: string }],
      );

      return new Response(result.body, {
        status: result.status,
        headers: result.headers,
      });
    } finally {
      this.releasePage(page);
    }
  }

  /**
   * Session cookie definitions for each provider.
   */
  static readonly SESSION_COOKIES: Record<string, { domain: string; cookieNames: string[] }> = {
    'claude-web': { domain: 'claude.ai', cookieNames: ['sessionKey', 'intercom-session-'] },
    'chatgpt-web': { domain: 'chatgpt.com', cookieNames: ['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0', 'session-token'] },
    'deepseek-web': { domain: 'deepseek.com', cookieNames: ['ds_session_id', 'token', 'userToken'] },
    'kimi-web': { domain: 'kimi.ai', cookieNames: ['access_token', 'kimi-auth', 'token', 'k_id', 'user_id', 'refresh_token'] },
    'qwen-web': { domain: 'qwen.ai', cookieNames: ['cna', 'ajs_anonymous_id', 'token', 'login_aliyunid_ticket', 'login_tongyi_ticket'] },
    'glm-web': { domain: 'z.ai', cookieNames: ['token', 'session', 'auth', 'chatglm_refresh_token', 'chatglm_token'] },
    'grok-web': { domain: 'grok.com', cookieNames: ['sso', 'ct0', 'auth_token'] },
    'gemini-web': { domain: 'google.com', cookieNames: ['SID', '__Secure-1PSID', 'HSID', 'SSID', 'APISID', 'SAPISID'] },
    'perplexity-web': { domain: 'perplexity.ai', cookieNames: ['__Secure-next-auth.session-token', 'next-auth.session-token', 'session-token'] },
  };

  /**
   * Check if given cookies contain valid session cookies for providerId.
   */
  hasSessionCookies(cookies: Array<{ domain: string; name: string; value: string }>, providerId: string): boolean {
    const config = BrowserManager.SESSION_COOKIES[providerId];
    if (!config) return false;
    const domainCookies = cookies.filter(c =>
      c.domain.includes(config.domain) ||
      (providerId === 'kimi-web' && (c.domain.includes('moonshot.cn') || c.domain.includes('kimi.com'))) ||
      (providerId === 'glm-web' && (c.domain.includes('chatglm') || c.domain.includes('bigmodel.cn'))) ||
      (providerId === 'gemini-web' && c.domain.includes('gemini.google.com')) ||
      (providerId === 'chatgpt-web' && c.domain.includes('openai.com')) ||
      (providerId === 'grok-web' && (c.domain.includes('x.com') || c.domain.includes('twitter.com'))) ||
      (providerId === 'qwen-web' && (c.domain.includes('aliyun.com') || c.domain.includes('tongyi.aliyun.com')))
    );
    return config.cookieNames.some(name =>
      domainCookies.some(c => c.name.toLowerCase().includes(name.toLowerCase()) && c.value && c.value.length > 0)
    );
  }

  /**
   * Check if a page has successfully logged into the target provider
   * (e.g. redirected away from login/auth pages to the main application interface).
   */
  async isPageAuthenticated(page: Page, providerId: string): Promise<boolean> {
    try {
      if (page.isClosed()) return false;
      const url = page.url();
      if (!url || url === 'about:blank') return false;

      switch (providerId) {
        case 'gemini-web':
          if (url.includes('gemini.google.com') && !url.includes('accounts.google.com')) {
            const hasChat = await page.$('input-area, [role="textbox"], textarea, button[aria-label*="Send" i], .chat-history').catch(() => null);
            return !!hasChat || (!url.includes('/signin') && !url.includes('/signup'));
          }
          return false;
        case 'claude-web':
          if (url.includes('claude.ai') && !url.includes('/login') && !url.includes('auth.claude.ai')) {
            const hasInput = await page.$('div[contenteditable="true"], fieldset, [data-testid="chat-message-assistant"]').catch(() => null);
            return !!hasInput || url.includes('/chat');
          }
          return false;
        case 'chatgpt-web':
          if (url.includes('chatgpt.com') && !url.includes('/auth') && !url.includes('/login')) {
            const hasInput = await page.$('#prompt-textarea, textarea, div[contenteditable="true"]').catch(() => null);
            return !!hasInput;
          }
          return false;
        case 'deepseek-web':
          if (url.includes('deepseek.com') && !url.includes('/sign_in') && !url.includes('/login')) {
            const hasInput = await page.$('textarea, #chat-input').catch(() => null);
            return !!hasInput;
          }
          return false;
        case 'kimi-web':
          if ((url.includes('kimi.ai') || url.includes('moonshot.cn') || url.includes('kimi.com')) && !url.includes('/auth') && !url.includes('/login')) {
            const hasInput = await page.$('div[contenteditable="true"], .editor, textarea, [data-testid="chat-input"]').catch(() => null);
            return !!hasInput;
          }
          return false;
        case 'qwen-web':
          if (url.includes('qwen.ai') && !url.includes('/auth') && !url.includes('/login')) {
            const hasInput = await page.$('textarea, div[contenteditable="true"]').catch(() => null);
            return !!hasInput;
          }
          return false;
        case 'glm-web':
          if ((url.includes('z.ai') || url.includes('chatglm')) && !url.includes('/login') && !url.includes('/sign')) {
            const hasInput = await page.$('textarea, div[contenteditable="true"], [placeholder*="输入" i]').catch(() => null);
            return !!hasInput;
          }
          return false;
        case 'grok-web':
          if (url.includes('grok.com') && !url.includes('/login') && !url.includes('/signin')) {
            const hasInput = await page.$('textarea, div[contenteditable="true"]').catch(() => null);
            return !!hasInput;
          }
          return false;
        case 'perplexity-web':
          if (url.includes('perplexity.ai') && !url.includes('/login') && !url.includes('/signin') && !url.includes('/auth')) {
            const hasInput = await page.$('textarea, div[contenteditable="true"]').catch(() => null);
            return !!hasInput;
          }
          return false;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Scan all providers against connected browser cookies and open tabs to detect
   * any active login sessions already established in Chrome.
   */
  async scanActiveSessions(): Promise<string[]> {
    try {
      if (!this.isContextAlive()) return [];
      const ctx = await this.ensureBrowser();
      const cookies = await ctx.cookies().catch(() => []);
      const active: string[] = [];

      for (const providerId of Object.keys(BrowserManager.SESSION_COOKIES)) {
        if (this.hasSessionCookies(cookies, providerId)) {
          active.push(providerId);
        }
      }

      // Also check open tabs
      const openPages = ctx.pages().filter(p => !p.isClosed());
      for (const providerId of Object.keys(BrowserManager.SESSION_COOKIES)) {
        if (active.includes(providerId)) continue;
        for (const page of openPages) {
          if (await this.isPageAuthenticated(page, providerId)) {
            active.push(providerId);
            break;
          }
        }
      }

      return active;
    } catch {
      return [];
    }
  }

  /**
   * In attach mode: open tab in existing Chrome and monitor session cookies.
   * In launch mode: open headed Chrome for login and monitor session cookies.
   */
  /**
   * In attach mode: open tab in dedicated Chrome and monitor session cookies.
   * In launch mode: open headed Chrome for login and monitor session cookies.
   * Supports multiple concurrent provider logins without blocking each other.
   */
  async startLogin(providerId: string, loginUrl: string, onComplete: (success: boolean) => void): Promise<void> {
    // If login is already in progress for THIS provider, bring its page to front
    const existing = this._loginStates.get(providerId);
    if (existing && (existing.status === 'opening' || existing.status === 'waiting_for_user')) {
      const existingPage = this._loginPages.get(providerId);
      if (existingPage && !existingPage.isClosed()) {
        await existingPage.bringToFront().catch(() => {});
        return;
      }
    }

    if (this._mode === 'attach') {
      try {
        const ctx = await this.ensureBrowser();

        // Check if ALREADY logged in via existing cookies
        const initialCookies = await ctx.cookies().catch(() => []);
        if (this.hasSessionCookies(initialCookies, providerId)) {
          this._loginStates.set(providerId, {
            providerId,
            status: 'success',
            message: `Already authenticated in Chrome. Session active.`,
            startedAt: null,
          });
          onComplete(true);
          return;
        }

        // Check if any existing open tab is already authenticated
        const existingPages = ctx.pages().filter(p => !p.isClosed());
        for (const p of existingPages) {
          if (await this.isPageAuthenticated(p, providerId)) {
            this._loginStates.set(providerId, {
              providerId,
              status: 'success',
              message: `Active authenticated tab found in Chrome. Session active.`,
              startedAt: null,
            });
            onComplete(true);
            return;
          }
        }

        const page = await ctx.newPage();
        this._loginPages.set(providerId, page);

        this._loginStates.set(providerId, {
          providerId,
          status: 'waiting_for_user',
          message: `Opened ${loginUrl} in Chrome. Please complete login in the tab.`,
          startedAt: Date.now(),
        });

        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: this.opts.startupTimeout }).catch(() => {});
        await page.bringToFront().catch(() => {});

        let isDone = false;
        const maxWaitMs = this.opts.loginTimeout * 1000;
        const startTime = Date.now();

        const finishLogin = (success: boolean, msg?: string) => {
          if (isDone) return;
          isDone = true;
          clearInterval(checkTimer);
          this._loginPages.delete(providerId);

          if (success) {
            this._loginStates.set(providerId, {
              providerId,
              status: 'success',
              message: `Login verified for ${providerId}. Session active.`,
              startedAt: null,
            });
            onComplete(true);
            setTimeout(() => {
              if (this._loginStates.get(providerId)?.status === 'success') {
                this._loginStates.delete(providerId);
              }
            }, 10000);
          } else {
            this._loginStates.set(providerId, {
              providerId,
              status: 'failed',
              message: msg || `Login not completed for ${providerId}.`,
              startedAt: null,
            });
            onComplete(false);
          }
        };

        const checkTimer = setInterval(async () => {
          if (isDone) return;
          try {
            const cookies = await ctx.cookies();
            const hasCookies = this.hasSessionCookies(cookies, providerId);
            const isAuthPage = await this.isPageAuthenticated(page, providerId);
            if (hasCookies || isAuthPage) {
              finishLogin(true);
              return;
            }
          } catch {
            // Context may be cycling
          }

          if (Date.now() - startTime > maxWaitMs) {
            finishLogin(false, 'Login timed out before session was detected.');
          }
        }, 2000);

        page.on('close', async () => {
          setTimeout(async () => {
            if (isDone) return;
            try {
              const cookies = await ctx.cookies();
              const hasCookies = this.hasSessionCookies(cookies, providerId);
              const isAuthPage = await this.isPageAuthenticated(page, providerId);
              if (hasCookies || isAuthPage) {
                finishLogin(true);
              } else {
                finishLogin(false, 'Login tab closed before authentication completed.');
              }
            } catch {
              finishLogin(false, 'Login tab closed.');
            }
          }, 500);
        });

      } catch (err) {
        this._loginStates.set(providerId, {
          providerId,
          status: 'failed',
          message: `Failed: ${(err as Error).message}`,
          startedAt: null,
        });
        onComplete(false);
      }
      return;
    }

    // Launch mode — open headed Chrome
    this._loginStates.set(providerId, { providerId, status: 'opening', message: 'Launching Chrome...', startedAt: Date.now() });

    try {
      if (!this.context || !this.isContextAlive()) {
        const { chromium } = await import('playwright-core');
        const executablePath = this.findChrome();
        if (!executablePath) {
          this._loginStates.set(providerId, { providerId, status: 'failed', message: 'Chrome not found.', startedAt: null });
          onComplete(false);
          return;
        }

        this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
          headless: false,
          executablePath,
          args: ['--no-first-run', '--no-default-browser-check'],
          timeout: this.opts.startupTimeout,
        });
      }

      const headedContext = this.context;
      const page: Page = await headedContext.newPage();
      this._loginPages.set(providerId, page);

      this._loginStates.set(providerId, {
        providerId,
        status: 'waiting_for_user',
        message: `Chrome window opened. Please log in at ${loginUrl}`,
        startedAt: Date.now(),
      });

      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.bringToFront().catch(() => {});

      let isDone = false;
      const maxWaitMs = this.opts.loginTimeout * 1000;
      const startTime = Date.now();

      const finishLaunchLogin = async (success: boolean, msg?: string) => {
        if (isDone) return;
        isDone = true;
        clearInterval(checkTimer);
        this._loginPages.delete(providerId);

        if (success) {
          this._loginStates.set(providerId, { providerId, status: 'success', message: `Login completed for ${providerId}.`, startedAt: null });
          onComplete(true);
          setTimeout(() => {
            if (this._loginStates.get(providerId)?.status === 'success') {
              this._loginStates.delete(providerId);
            }
          }, 10000);
        } else {
          this._loginStates.set(providerId, { providerId, status: 'failed', message: msg || `Login incomplete for ${providerId}.`, startedAt: null });
          onComplete(false);
        }
      };

      const checkTimer = setInterval(async () => {
        if (isDone) return;
        try {
          const cookies = await headedContext.cookies();
          const hasCookies = this.hasSessionCookies(cookies, providerId);
          const isAuth = await this.isPageAuthenticated(page, providerId);
          if (hasCookies || isAuth) {
            await finishLaunchLogin(true);
            return;
          }
        } catch {
          // Context closed
        }

        if (Date.now() - startTime > maxWaitMs) {
          await finishLaunchLogin(false, 'Login timed out before session was detected.');
        }
      }, 2000);

      page.on('close', async () => {
        setTimeout(async () => {
          if (isDone) return;
          try {
            const cookies = await headedContext.cookies();
            const hasCookies = this.hasSessionCookies(cookies, providerId);
            const isAuth = await this.isPageAuthenticated(page, providerId);
            await finishLaunchLogin(hasCookies || isAuth, 'Window closed before authentication.');
          } catch {
            await finishLaunchLogin(false, 'Window closed.');
          }
        }, 500);
      });

    } catch (err) {
      this._loginStates.set(providerId, { providerId, status: 'failed', message: `Failed: ${(err as Error).message}`, startedAt: null });
      onComplete(false);
    }
  }

  /**
   * Auto-detect which providers have valid cookies in the connected browser.
   * Returns a map of providerId → true for providers with cookies.
   */
  async autoDetectAuth(): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};

    try {
      const ctx = await this.ensureBrowser();
      const cookies = await ctx.cookies();

      for (const providerId of Object.keys(BrowserManager.SESSION_COOKIES)) {
        result[providerId] = this.hasSessionCookies(cookies, providerId);
      }
    } catch {
      // Browser not available
    }

    return result;
  }

  getLoginState(providerId?: string): LoginState {
    if (providerId && this._loginStates.has(providerId)) {
      return { ...this._loginStates.get(providerId)! };
    }
    const active = Array.from(this._loginStates.values()).find(
      s => s.status === 'opening' || s.status === 'waiting_for_user'
    );
    if (active) return { ...active };
    return { providerId: null, status: 'idle', message: '', startedAt: null };
  }

  getAllLoginStates(): Record<string, LoginState> {
    const res: Record<string, LoginState> = {};
    for (const [id, state] of this._loginStates.entries()) {
      res[id] = { ...state };
    }
    return res;
  }

  getMode(): BrowserMode {
    return this._mode;
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.domainPages.clear();
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this._status = 'stopped';
  }

  getStatus(): BrowserStatus {
    return this._status;
  }

  /**
   * Try to detect if Chrome is already running with remote debugging.
   */
  async detectCDP(cdpUrl?: string): Promise<boolean> {
    const url = cdpUrl ?? this.opts.cdpUrl ?? 'http://127.0.0.1:9222';
    try {
      const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private getChromeStartCommand(): string {
    const chromePath = this.findChrome();
    const os = platform();

    if (os === 'darwin') {
      return `  # macOS:\n  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n\n  # Or create an alias in ~/.zshrc:\n  alias chrome-debug='/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222'`;
    }
    if (os === 'win32') {
      return `  # Windows (PowerShell):\n  & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222`;
    }
    // Linux
    const bin = chromePath ?? 'google-chrome';
    return `  # Linux:\n  ${bin} --remote-debugging-port=9222`;
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.opts.idleShutdown > 0) {
      this.idleTimer = setTimeout(() => {
        this._status = 'idle';
        this.shutdown();
      }, this.opts.idleShutdown * 1000);
    }
  }

  private findChrome(): string | undefined {
    return findChromePath();
  }
}
