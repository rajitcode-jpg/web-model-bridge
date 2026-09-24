import type { Page } from 'playwright-core';
import type { StreamEvent } from '../core/stream.js';
import { type FileAttachment, persistFileToDisk } from '../core/file-handler.js';
import { existsSync } from 'node:fs';

export interface ErrorScene {
  screenshot: string; // base64 data URI
  url: string;
  title: string;
  details: string;
  timestamp: number;
}

export interface ChatInteractionOptions {
  providerId: string;
  model: string;
  prompt: string;
  files?: FileAttachment[];
  timeoutMs?: number;
}

export interface TypingOptions {
  typingDelayMs?: number; // e.g. 12ms for ~100 WPM
}

/**
 * Strips XML/tag-based thinking indicators and residual status phrases from response text.
 */
export function sanitizeResponseText(text: string): string {
  if (!text) return '';
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '')
    .replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '')
    .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
    .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
    .trim();
}

/**
 * Extracts clean assistant response text from a DOM element by removing:
 * - Thinking / reasoning blocks (DeepSeek R1, Qwen QwQ, Kimi, GLM, Grok, Gemini, ChatGPT, Claude)
 * - Artifact previews, tool execution widgets, plugin outputs
 * - Web search status / citation cards
 * - UI chrome (buttons, SVGs, copy buttons, feedback thumbs, headers/footers)
 * - Text-based <think>...</think> tags and status headers
 */
export function extractCleanAssistantText(target: HTMLElement | null): string {
  if (!target) return '';
  const clone = target.cloneNode(true) as HTMLElement;

  const selectorsToRemove = [
    // Thinking & reasoning containers
    '[class*="think" i]',
    '[class*="thought" i]',
    '[class*="reasoning" i]',
    '[data-testid*="think" i]',
    '[data-testid*="thought" i]',
    '[data-testid*="reasoning" i]',
    '[data-test-id*="think" i]',
    '[data-test-id*="thought" i]',
    '[data-test-id*="reasoning" i]',
    'model-thoughts',
    '.ds-think',
    'details',
    'summary',
    '[class*="collapse" i]',

    // Qwen & status card reasoning containers
    '[class*="status-card" i]',
    '[class*="tool-status" i]',
    '[class*="tool-card" i]',
    '[class*="thinking-tool" i]',
    '.qwen-chat-thinking-tool-status-card-wraper',
    '.qwen-chat-thinking-tool-content',
    '.qwen-chat-tool-status-card',
    '[class*="phase-think" i]',

    // Artifacts & tool widgets
    '[data-testid*="artifact" i]',
    '[class*="artifact" i]',
    '[data-testid*="tool" i]',
    '[class*="tool-call" i]',
    '[class*="toolcall-flow" i]',
    '[class*="thinking-container" i]',
    '[class*="is-flat-think" i]',
    '.thinking-chain-container',
    '[class*="thinking-chain" i]',
    '[class*="plugin" i]',

    // Search process & citation cards
    '[class*="search-process" i]',
    '[class*="search-status" i]',
    '[class*="search-result" i]',
    '[class*="ref-item" i]',
    '[class*="citation-badge" i]',

    // UI chrome & action buttons
    'button',
    'svg',
    '[role="button"]',
    '[aria-label*="Copy" i]',
    '[aria-label*="copy" i]',
    '[class*="copy-button" i]',
    '[class*="copy-btn" i]',
    '[class*="action-buttons" i]',
    '[class*="action-bar" i]',
    '[class*="message-actions" i]',
    '[class*="toolbar" i]',
    '[class*="feedback" i]',
    '[class*="vote" i]',
    '[class*="avatar" i]',
  ];

  selectorsToRemove.forEach((sel) => {
    clone.querySelectorAll(sel).forEach((el) => el.remove());
  });

  return sanitizeResponseText(clone.textContent || '');
}

export class BrowserUIDriver {
  constructor(
    public readonly getPage: (origin: string) => Promise<Page>,
    public readonly releasePage?: (page: Page) => void,
  ) {}

  private safeRelease(page: Page): void {
    try {
      if (this.releasePage) {
        this.releasePage(page);
      } else if (typeof (page as any).release === 'function') {
        (page as any).release();
      }
    } catch {}
  }

  private async enterPrompt(page: Page, prompt: string, delayMs?: number): Promise<void> {
    if (delayMs && delayMs > 0) {
      await page.keyboard.type(prompt, { delay: delayMs });
    } else {
      await page.keyboard.insertText(prompt);
    }
  }

  /**
   * Capture a visual error scene from the current page
   */
  async captureErrorScene(page: Page, details: string): Promise<ErrorScene> {
    let screenshot = '';
    let title = '';
    let url = '';

    try {
      url = page.url();
      title = await page.title().catch(() => '');
      const buffer = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      if (buffer) {
        screenshot = `data:image/jpeg;base64,${buffer.toString('base64')}`;
      }
    } catch {
      // Ignore screenshot errors
    }

    return {
      screenshot,
      url,
      title,
      details,
      timestamp: Date.now(),
    };
  }

  /**
   * Detect in-page error banners, alerts, toast notifications, rate limits, or capacity failures.
   */
  async detectPageError(page: Page): Promise<string | null> {
    try {
      return await page.evaluate(() => {
        // 1. Check known alert and toast elements
        const errorSelectors = [
          '[role="alert"]',
          '[aria-live="assertive"]',
          '.ant-message-error',
          '.ant-notification-notice-error',
          '[class*="toast-error" i]',
          '[class*="error-message" i]',
          '[class*="errorMessage" i]',
          '[class*="error-tip" i]',
          '[class*="error_tip" i]',
          '[class*="error-notice" i]',
          '[class*="error-card" i]',
          '[class*="error-modal" i]',
          '[class*="error-box" i]',
          '[class*="error_msg" i]',
          '[data-testid*="error" i]',
          '[class*="alert-danger" i]',
          '[class*="alert-error" i]',
        ];

        for (const sel of errorSelectors) {
          const els = document.querySelectorAll(sel);
          for (const el of Array.from(els)) {
            const text = (el.textContent || '').trim();
            if (text && text.length > 3 && text.length < 500) {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return text;
              }
            }
          }
        }

        // 2. Check general modals, toasts, popups, banners, alerts for error keywords
        const patterns = [
          /(?:usage|message|daily|hourly|request|rate|token)?\s*limit\s*(?:reached|exceeded|hit)/i,
          /you(?:'ve| have) reached (?:your|the) (?:message|usage|daily|free)?\s*limit/i,
          /out of (?:free )?messages/i,
          /too many requests/i,
          /try again (?:after|in|later|tomorrow)/i,
          /额度已用完|次数已达上限|使用次数超限|请求过于频繁|访问限制|达到上限/,
          /file (?:not found|missing|too large|exceeds|unsupported|upload failed)/i,
          /upload (?:failed|error|rejected)/i,
          /unsupported (?:file|format|type)/i,
          /maximum file size/i,
          /文件上传失败|文件过大|不支持的文件格式|文件不存在/,
          /server (?:is )?(?:busy|overloaded|error|unavailable|at capacity)/i,
          /high traffic/i,
          /capacity reached/i,
          /something went wrong/i,
          /failed to generate/i,
          /network error/i,
          /session (?:expired|timed out)/i,
          /please (?:sign in|log in) again/i,
          /服务器繁忙|服务异常|网络错误|生成失败|系统繁忙|登录已过期|服务不可用/,
          /content (?:moderated|policy violation|violates our policies)/i,
        ];

        const candidateElements = document.querySelectorAll(
          '.ant-modal, .ant-message, [class*="toast"], [class*="banner"], [class*="alert"], [class*="notice"], [class*="dialog"], [class*="popup"], [class*="modal"]'
        );
        for (const el of Array.from(candidateElements)) {
          const text = (el.textContent || '').trim();
          if (text && text.length > 3 && text.length < 500) {
            for (const pattern of patterns) {
              if (pattern.test(text)) {
                return text;
              }
            }
          }
        }

        return null;
      });
    } catch {
      return null;
    }
  }

  private async validateAndPrepareFiles(
    page: Page,
    files: FileAttachment[],
    _providerName: string,
  ): Promise<{ success: boolean; errorEvent?: StreamEvent; validPaths: string[] }> {
    for (const f of files) {
      if (f.path && !existsSync(f.path) && !f.data) {
        const scene = await this.captureErrorScene(page, `File not found: ${f.path}`);
        return {
          success: false,
          errorEvent: { type: 'error', message: `File not found: ${f.path}`, scene } as any,
          validPaths: [],
        };
      }
      if (!f.path && f.data) {
        persistFileToDisk(f);
      }
    }

    const validPaths = files.map(f => f.path).filter((p): p is string => !!p && existsSync(p));
    if (files.length > 0 && validPaths.length === 0) {
      const scene = await this.captureErrorScene(page, 'No valid file attachments found.');
      return {
        success: false,
        errorEvent: { type: 'error', message: 'No valid file attachments found to upload.', scene } as any,
        validPaths: [],
      };
    }

    return { success: true, validPaths };
  }

  private async uploadFilesToInput(
    page: Page,
    filePaths: string[],
    providerName: string,
  ): Promise<{ success: boolean; errorEvent?: StreamEvent }> {
    if (filePaths.length === 0) return { success: true };
    const fileInput = await page.$('input[type="file"]').catch(() => null);
    if (!fileInput) {
      const scene = await this.captureErrorScene(page, `${providerName} file input element not found.`);
      return {
        success: false,
        errorEvent: {
          type: 'error',
          message: `${providerName} file upload input element not found. This provider view may not support file attachments.`,
          scene,
        } as any,
      };
    }

    try {
      await fileInput.setInputFiles(filePaths);
      await page.waitForTimeout(1500);
    } catch (err) {
      const scene = await this.captureErrorScene(page, `File upload failed: ${(err as Error).message}`);
      return {
        success: false,
        errorEvent: {
          type: 'error',
          message: `Failed to upload file to ${providerName}: ${(err as Error).message}`,
          scene,
        } as any,
      };
    }

    const pageError = await this.detectPageError(page);
    if (pageError) {
      const scene = await this.captureErrorScene(page, pageError);
      return {
        success: false,
        errorEvent: {
          type: 'error',
          message: `${providerName} file error: ${pageError}`,
          scene,
        } as any,
      };
    }

    return { success: true };
  }

  /**
   * Interact with Google Gemini Web UI
   */
  async *chatWithGemini(page: Page, prompt: string, files: FileAttachment[] = [], timeoutMsOrOpts: number | TypingOptions = 90000, options?: TypingOptions): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      // Ensure we are on Gemini web app
      if (!page.url().includes('gemini.google.com')) {
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.bringToFront().catch(() => {});

      // Let the page settle and network requests complete
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // Check if redirected to Google sign-in
      if (page.url().includes('accounts.google.com')) {
        const scene = await this.captureErrorScene(page, 'Gemini requires Google account sign-in.');
        yield { type: 'error', message: 'Gemini is not logged in. Please log in with your Google account first.', scene } as any;
        return;
      }

      // Handle any welcome/terms popups if present
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const b of buttons) {
          const txt = (b.textContent || '').toLowerCase();
          if (txt.includes('agree') || txt.includes('accept') || txt.includes('continue') || txt.includes('got it')) {
            b.click();
          }
        }
      }).catch(() => {});

      // Wait for input container to be visible and interactive
      const inputSelector = 'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'Gemini chat input box not found. Check if tab needs attention or login.');
        yield { type: 'error', message: 'Gemini chat input box not found. Make sure you are logged in to Gemini.', scene } as any;
        return;
      }

      // Upload any files first
      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'Gemini');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'Gemini');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      // Count existing response containers before sending
      const geminiResponseSelector = 'model-response, message-content, .response-container-content, [data-test-id*="response"]';
      const initialResponseCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, geminiResponseSelector);

      // Focus input element and put text via native insertion (prevents Quill/Angular desync and error 13)
      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(300);

      // Clear any placeholder/previous text
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');

      // Type prompt using keyboard insertion
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);

      // Verify text was inserted, fallback to execCommand if needed
      const inserted = await page.evaluate((sel) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return ((el?.textContent || (el as any)?.value || '')).length > 0;
      }, inputSelector);

      if (!inserted) {
        await page.evaluate(({ sel, text }) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el) {
            el.focus();
            document.execCommand('insertText', false, text);
          }
        }, { sel: inputSelector, text: prompt });
      }

      // Allow Gemini UI state to enable the submit button
      await page.waitForTimeout(500);

      // Click send button
      const clicked = await page.evaluate(() => {
        const sendBtn = document.querySelector('button[aria-label*="Send prompt" i], button[aria-label*="Send message" i], button.send-button, button[aria-label*="Submit" i], button[mat-icon-button]:has(mat-icon)') as HTMLButtonElement | null;
        if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute('aria-disabled') !== 'true') {
          sendBtn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        await page.keyboard.press('Enter');
      }

      // Now stream response from newly created response element
      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `Gemini error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initialCount, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[data-testid*="tool" i]',
              '[class*="tool" i]',
              '[class*="plugin" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-buttons" i]',
              '[class*="action-bar" i]',
              '[class*="message-actions" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const responses = Array.from(document.querySelectorAll(sel));
          const target = responses.length > initialCount ? (responses[responses.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true, fileUrls: [] };
          const text = cleanDOMText(target);

          const stopButton = document.querySelector('button[aria-label*="Stop" i], button.stop-button');
          const isGenerating = !!stopButton;

          // Check for generated files or images
          const fileUrls: string[] = [];
          if (target) {
            const imgs = target.querySelectorAll('img');
            imgs.forEach(img => {
              if (img.src && !img.src.includes('avatar') && !img.src.includes('sparkle')) {
                fileUrls.push(img.src);
              }
            });
            const links = target.querySelectorAll('a[download], a[href*="blob:"]');
            links.forEach(a => {
              if ((a as HTMLAnchorElement).href) fileUrls.push((a as HTMLAnchorElement).href);
            });
          }

          return {
            text,
            isGenerating,
            fileUrls,
          };
        }, { initialCount: initialResponseCount, sel: geminiResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        // Check if finished
        if (accumulatedText.length > 0) {
          if (!status.isGenerating && Date.now() - lastTextChange > 2500) {
            // Check for any returned files/images
            if (status.fileUrls && status.fileUrls.length > 0) {
              yield {
                type: 'files',
                files: status.fileUrls.map((url, idx) => ({
                  name: `gemini_artifact_${idx + 1}`,
                  type: 'image/jpeg',
                  url,
                })),
              } as any;
            }
            yield { type: 'done', reason: 'stop' };
            return;
          }
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'Gemini response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
      } else {
        yield { type: 'done', reason: 'stop' };
      }
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `Gemini execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with DeepSeek Web UI (chat.deepseek.com)
   * Strictly avoids sidebar "Search chat" inputs.
   */
  async *chatWithDeepSeek(page: Page, prompt: string, files: FileAttachment[] = [], timeoutMsOrOpts: number | TypingOptions = 90000, options?: TypingOptions): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('deepseek.com')) {
        await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000);

      // Check if redirected to login page
      if (page.url().includes('/sign_in') || page.url().includes('/login')) {
        const scene = await this.captureErrorScene(page, 'DeepSeek requires login.');
        yield { type: 'error', message: 'DeepSeek is not logged in. Please log in first.', scene } as any;
        return;
      }

      // CRITICAL: Explicitly select DeepSeek chat input and NEVER the sidebar search box!
      const inputSelector = '#chat-input, textarea#chat-input, textarea[placeholder*="DeepSeek" i], textarea[placeholder*="Send a message" i], div[class*="chat-input"] textarea, footer textarea';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'DeepSeek main chat input not found.');
        yield { type: 'error', message: 'DeepSeek chat input box not found. Ensure you are logged into DeepSeek.', scene } as any;
        return;
      }

      // Attach files if any
      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'DeepSeek');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'DeepSeek');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const deepseekResponseSelector = '.ds-markdown, .ds-markdown--block, [class*="ds-message"]:not([class*="user"]), div.chat-message:not(.user)';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, deepseekResponseSelector);

      // Focus and type into the main input
      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);

      await page.waitForTimeout(300);

      // Submit
      const clicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('div[role="button"][aria-label*="Send" i], div[class*="send-button"], button[aria-label*="Send" i], #chat-input ~ div button, div[class*="chat-input"] div[role="button"]'));
        const sendBtn = candidates[candidates.length - 1] as HTMLElement | null;
        if (sendBtn && !sendBtn.hasAttribute('disabled') && sendBtn.getAttribute('aria-disabled') !== 'true') {
          sendBtn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        await page.keyboard.press('Enter');
      }

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `DeepSeek error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[data-testid*="tool" i]',
              '[class*="tool" i]',
              '[class*="plugin" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-buttons" i]',
              '[class*="action-bar" i]',
              '[class*="message-actions" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const messages = Array.from(document.querySelectorAll(sel));
          const target = messages.length > initial ? (messages[messages.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true };
          const text = cleanDOMText(target);

          const stopBtn = document.querySelector('div[role="button"][aria-label*="Stop" i], button[aria-label*="Stop" i], div[class*="stop-button"]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: deepseekResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'DeepSeek response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `DeepSeek execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with Claude Web UI (claude.ai)
   * Filters out right-side artifact panels, "constructing...", "using tool...", and status cards.
   */
  async *chatWithClaude(page: Page, prompt: string, files: FileAttachment[] = [], timeoutMsOrOpts: number | TypingOptions = 90000, options?: TypingOptions): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('claude.ai')) {
        await page.goto('https://claude.ai/new', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000);

      // Check for login
      if (page.url().includes('/login') || page.url().includes('auth.claude.ai')) {
        const scene = await this.captureErrorScene(page, 'Claude requires login.');
        yield { type: 'error', message: 'Claude is not logged in. Please log in first.', scene } as any;
        return;
      }

      const inputSelector = 'div[contenteditable="true"][data-placeholder], div[contenteditable="true"].ProseMirror, fieldset div[contenteditable="true"], div[contenteditable="true"]';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'Claude chat input box not found.');
        yield { type: 'error', message: 'Claude chat input box not found. Ensure you are logged in.', scene } as any;
        return;
      }

      // Attach files if any
      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'Claude');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'Claude');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const claudeResponseSelector = 'main div.font-claude-message, main [data-testid="chat-message-assistant"], main div[data-is-streaming]';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, claudeResponseSelector);

      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);

      await page.waitForTimeout(400);

      // Send prompt
      const clicked = await page.evaluate(() => {
        const sendBtn = document.querySelector('button[aria-label*="Send Message" i], button[aria-label*="Send prompt" i], button:has(svg path[d*="M2.01 21L23 12 2.01 3"])') as HTMLButtonElement | null;
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        await page.keyboard.press('Enter');
      }

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `Claude error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[data-testid*="tool" i]',
              '[class*="tool" i]',
              '[class*="plugin" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-buttons" i]',
              '[class*="action-bar" i]',
              '[class*="message-actions" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const messages = Array.from(document.querySelectorAll(sel));
          const target = messages.length > initial ? (messages[messages.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true };
          const text = cleanDOMText(target);

          const stopBtn = document.querySelector('button[aria-label*="Stop" i], [data-testid="stop-button"]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: claudeResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'Claude response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `Claude execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with Grok Web UI (grok.com)
   */
  async *chatWithGrok(page: Page, prompt: string, files: FileAttachment[] = [], timeoutMsOrOpts: number | TypingOptions = 90000, options?: TypingOptions): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('grok.com')) {
        await page.goto('https://grok.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000);

      // Check login
      if (page.url().includes('/login') || page.url().includes('/signin')) {
        const scene = await this.captureErrorScene(page, 'Grok requires login.');
        yield { type: 'error', message: 'Grok is not logged in. Please log in first.', scene } as any;
        return;
      }

      const inputSelector = 'div.query-bar-editor, div.ProseMirror, div[contenteditable="true"], textarea[placeholder*="Ask" i], textarea[placeholder*="Grok" i], textarea[placeholder*="anything" i]';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'Grok chat input box not found.');
        yield { type: 'error', message: 'Grok chat input box not found. Check if tab is ready and logged in.', scene } as any;
        return;
      }

      // Attach files if any
      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'Grok');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'Grok');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const grokResponseSelector = 'div.message-bubble:not([class*="user"]):not([class*="wd-user-bubble"]) .response-content-markdown, div.message-bubble:not([class*="user"]):not([class*="wd-user-bubble"]), [data-testid*="grok-response"], [data-testid*="message-assistant"]';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, grokResponseSelector);

      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);
      await page.waitForTimeout(300);

      // Verify text presence, fallback if needed
      const hasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (!hasText) {
        await inputLocator.evaluate((el, text) => {
          if ('value' in el) (el as any).value = text;
          else el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, prompt).catch(() => {});
      }

      // Submit prompt by pressing Enter directly
      await inputLocator.press('Enter').catch(async () => {
        await page.keyboard.press('Enter');
      });
      await page.waitForTimeout(400);

      const stillHasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (stillHasText) {
        await page.keyboard.press('Enter');
      }

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `Grok error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[data-testid*="tool" i]',
              '[class*="plugin" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-buttons" i]',
              '[class*="action-bar" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const messages = Array.from(document.querySelectorAll(sel));
          const target = messages.length > initial ? (messages[messages.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true };
          const text = cleanDOMText(target);

          const stopBtn = document.querySelector('button[aria-label*="Stop" i], button.stop-button, [data-testid*="stop"]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: grokResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'Grok response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `Grok execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with ChatGPT Web UI
   */
  async *chatWithChatGPT(page: Page, prompt: string, files: FileAttachment[] = [], timeoutMsOrOpts: number | TypingOptions = 90000, options?: TypingOptions): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('chatgpt.com')) {
        await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }

      const inputSelector = '#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"]';
      const inputEl = await page.waitForSelector(inputSelector, { timeout: 15000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'ChatGPT input box not found.');
        yield { type: 'error', message: 'ChatGPT input box not found.', scene } as any;
        return;
      }

      // Attach files if provided
      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'ChatGPT');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'ChatGPT');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const chatgptResponseSelector = '[data-message-author-role="assistant"], div.agent-turn';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, chatgptResponseSelector);

      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);

      await page.waitForTimeout(300);

      // Click send
      const clicked = await page.evaluate(() => {
        const sendBtn = document.querySelector('button[data-testid="send-button"]') as HTMLButtonElement | null;
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return true;
        }
        return false;
      });

      if (!clicked) {
        await page.keyboard.press('Enter');
      }

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `ChatGPT error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[data-testid*="tool" i]',
              '[class*="tool" i]',
              '[class*="plugin" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-buttons" i]',
              '[class*="action-bar" i]',
              '[class*="message-actions" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const messages = Array.from(document.querySelectorAll(sel));
          const target = messages.length > initial ? (messages[messages.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true };
          const text = cleanDOMText(target);

          const stopBtn = document.querySelector('button[data-testid="stop-button"]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: chatgptResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'ChatGPT response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `ChatGPT execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Universal Web Model Driver (fallback for other web models)
   * Strictly excludes search inputs.
   */
  async *chatUniversal(
    page: Page,
    url: string,
    prompt: string,
    files: FileAttachment[] = [],
    timeoutMs = 90000,
  ): AsyncIterable<StreamEvent> {
    try {
      if (!page.url().includes(new URL(url).hostname)) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }

      // Universal input detection — strictly ignore search bars
      const inputSelector = '#chat-input, div[contenteditable="true"]:not([placeholder*="search" i]), textarea:not([placeholder*="search" i]):not([type="search"])';
      const inputEl = await page.waitForSelector(inputSelector, { timeout: 15000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, `Input element not found on ${url}`);
        yield { type: 'error', message: `Input element not found on ${url}`, scene } as any;
        return;
      }

      // Handle files
      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'Universal');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'Universal');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      // Focus and type prompt using native keyboard insert
      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(prompt);

      await page.waitForTimeout(300);

      // Attempt submit
      await page.evaluate(() => {
        const sendBtn = document.querySelector('button[aria-label*="Send" i], button[aria-label*="发送" i], button[type="submit"], div[role="button"][aria-label*="Send" i], div[role="button"][aria-label*="发送" i]') as HTMLElement | null;
        if (sendBtn) sendBtn.click();
      });
      await page.keyboard.press('Enter');

      // Universal stream detection
      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `Universal driver error: ${pageError}`, scene } as any;
            return;
          }
        }

        const text = await page.evaluate(() => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[data-testid*="tool" i]',
              '[class*="tool" i]',
              '[class*="plugin" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-buttons" i]',
              '[class*="action-bar" i]',
              '[class*="message-actions" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const candidates = Array.from(document.querySelectorAll('.font-claude-message, .ds-markdown, .message-content, [class*="assistant"], [class*="response"]'));
          const target = (candidates[candidates.length - 1] as HTMLElement | null);
          return cleanDOMText(target);
        });

        const cleanText = sanitizeResponseText(text);

        if (cleanText && cleanText.length > accumulatedText.length) {
          const delta = cleanText.slice(accumulatedText.length);
          accumulatedText = cleanText;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && Date.now() - lastTextChange > 3000) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'Universal driver timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `Universal driver error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with Moonshot Kimi Web UI (kimi.ai)
   */
  async *chatWithKimi(
    page: Page,
    prompt: string,
    files: FileAttachment[] = [],
    timeoutMsOrOpts: number | TypingOptions = 90000,
    options?: TypingOptions,
  ): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('kimi.ai') && !page.url().includes('moonshot.cn')) {
        await page.goto('https://kimi.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000);

      // Check login
      if (page.url().includes('/auth') || page.url().includes('/login')) {
        const scene = await this.captureErrorScene(page, 'Kimi requires login.');
        yield { type: 'error', message: 'Kimi is not logged in. Please log in to kimi.ai first.', scene } as any;
        return;
      }

      const inputSelector = 'div[contenteditable="true"], .editor, textarea, [data-testid="chat-input"]';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'Kimi chat input box not found.');
        yield { type: 'error', message: 'Kimi chat input box not found. Check if tab is ready.', scene } as any;
        return;
      }

      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'Kimi');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'Kimi');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const kimiResponseSelector = '.segment.segment-assistant, .segment-assistant, [class*="segment-assistant"]';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, kimiResponseSelector);

      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);
      await page.waitForTimeout(300);

      // Verify text presence, fallback if needed
      const hasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (!hasText) {
        await inputLocator.evaluate((el, text) => {
          if ('value' in el) (el as any).value = text;
          else el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, prompt).catch(() => {});
      }

      // Submit prompt by pressing Enter directly as instructed, NEVER clicking external/help SVG buttons
      await inputLocator.press('Enter').catch(async () => {
        await page.keyboard.press('Enter');
      });
      await page.waitForTimeout(400);
      const stillHasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (stillHasText) {
        await page.keyboard.press('Enter');
      }

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `Kimi error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="thinking-container" i]',
              '[class*="is-flat-think" i]',
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const containers = Array.from(document.querySelectorAll(sel));
          const target = containers.length > initial ? (containers[containers.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true };
          const text = cleanDOMText(target);

          const stopBtn = document.querySelector('button[aria-label*="停止" i], button[aria-label*="Stop" i], [class*="stop-button"]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: kimiResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'Kimi response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `Kimi execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with Alibaba Qwen Web UI (chat.qwen.ai)
   */
  async *chatWithQwen(
    page: Page,
    prompt: string,
    files: FileAttachment[] = [],
    timeoutMsOrOpts: number | TypingOptions = 90000,
    options?: TypingOptions,
  ): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('chat.qwen.ai') && !page.url().includes('qwen.ai')) {
        await page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000);

      // Check login
      if (page.url().includes('/auth') || page.url().includes('/login')) {
        const scene = await this.captureErrorScene(page, 'Qwen requires login.');
        yield { type: 'error', message: 'Qwen is not logged in. Please log in to chat.qwen.ai first.', scene } as any;
        return;
      }

      const inputSelector = 'textarea, div[contenteditable="true"], [placeholder*="Ask" i], [placeholder*="Message" i]';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'Qwen chat input box not found.');
        yield { type: 'error', message: 'Qwen chat input box not found. Check if tab is ready.', scene } as any;
        return;
      }

      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'Qwen');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'Qwen');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const qwenResponseSelector = '.qwen-chat-message-assistant, [class*="chat-message-assistant"]';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, qwenResponseSelector);

      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);
      await page.waitForTimeout(300);

      // Verify text presence, fallback if needed
      const hasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (!hasText) {
        await inputLocator.evaluate((el, text) => {
          if ('value' in el) (el as any).value = text;
          else el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, prompt).catch(() => {});
      }

      // Submit prompt by pressing Enter directly, NEVER clicking button:has(svg) (which hits clear/delete)
      await inputLocator.press('Enter').catch(async () => {
        await page.keyboard.press('Enter');
      });
      await page.waitForTimeout(400);
      const stillHasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (stillHasText) {
        // Safe fallback: only click dedicated send button if Enter didn't submit
        await page.evaluate(() => {
          const sendBtn = document.querySelector('.message-input-right-button-send, button[type="submit"]:not([disabled])') as HTMLElement | null;
          if (sendBtn) sendBtn.click();
        }).catch(() => {});
        await page.keyboard.press('Enter');
      }

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `Qwen error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[class*="status-card" i]',
              '[class*="tool-status" i]',
              '[class*="tool-card" i]',
              '[class*="thinking-tool" i]',
              '.qwen-chat-thinking-tool-status-card-wraper',
              '.qwen-chat-thinking-tool-content',
              '.qwen-chat-tool-status-card',
              '[class*="phase-think" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const assistants = Array.from(document.querySelectorAll(sel));
          const lastAssistant = assistants.length > initial ? (assistants[assistants.length - 1] as HTMLElement) : null;
          if (!lastAssistant) return { text: '', isGenerating: true };

          // Qwen thinking status card check
          const thinkingCard = lastAssistant.querySelector(
            '.qwen-chat-thinking-tool-status-card-wraper, .qwen-chat-tool-status-card, [class*="thinking"], [class*="status-card"]'
          );
          // Qwen actual answer container
          const phaseAnswer = lastAssistant.querySelector(
            '.response-message-content.phase-answer, .phase-answer, .custom-qwen-markdown:not([class*="think"])'
          );

          // If thinking container is present and answer phase has not rendered yet, it is still thinking: return empty text!
          if (thinkingCard && !phaseAnswer) {
            return { text: '', isGenerating: true };
          }

          const answerContainer = phaseAnswer || lastAssistant.querySelector('.response-message-content, .custom-qwen-markdown, .qwen-markdown') || lastAssistant;
          if (answerContainer.closest('[class*="thinking"], [class*="status-card"], .qwen-chat-thinking-tool-status-card-wraper')) {
            return { text: '', isGenerating: true };
          }

          const text = cleanDOMText(answerContainer as HTMLElement);

          const stopBtn = document.querySelector('[class*="stop"], button[aria-label*="Stop" i], button[aria-label*="停止" i]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: qwenResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'Qwen response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `Qwen execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with Zhipu GLM Web UI (chatglm.com / chatglm.cn)
   */
  async *chatWithGLM(
    page: Page,
    prompt: string,
    files: FileAttachment[] = [],
    timeoutMsOrOpts: number | TypingOptions = 90000,
    options?: TypingOptions,
  ): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('z.ai') && !page.url().includes('chatglm')) {
        await page.goto('https://z.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(async () => {
          await page.goto('https://chatglm.cn', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        });
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000);

      // Check login
      if (page.url().includes('/login') || page.url().includes('/sign')) {
        const scene = await this.captureErrorScene(page, 'GLM requires login.');
        yield { type: 'error', message: 'GLM is not logged in. Please log in first.', scene } as any;
        return;
      }

      const inputSelector = 'textarea, div[contenteditable="true"], [placeholder*="输入" i], [placeholder*="Ask" i]';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'GLM chat input box not found.');
        yield { type: 'error', message: 'GLM chat input box not found. Check if tab is ready.', scene } as any;
        return;
      }

      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'GLM');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'GLM');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const glmResponseSelector = '.chat-assistant, [class*="chat-assistant"], div[id^="message-"]:not(.user-message), [data-message-role="assistant"], .markdown-prose';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, glmResponseSelector);

      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);
      await page.waitForTimeout(300);

      // Verify text presence, fallback if needed
      const hasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (!hasText) {
        await inputLocator.evaluate((el, text) => {
          if ('value' in el) (el as any).value = text;
          else el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, prompt).catch(() => {});
      }

      // Submit prompt by pressing Enter directly as instructed, NEVER clicking button:has(svg)
      await inputLocator.press('Enter').catch(async () => {
        await page.keyboard.press('Enter');
      });
      await page.waitForTimeout(400);
      const stillHasText = await inputLocator.evaluate(el => !!((el as any).value || el.textContent || '').trim()).catch(() => false);
      if (stillHasText) {
        // Safe fallback: only click dedicated send button if Enter didn't submit
        await page.evaluate(() => {
          const sendBtn = document.querySelector('button[aria-label*="发送" i], button[aria-label*="Send" i], button[type="submit"]:not([disabled])') as HTMLElement | null;
          if (sendBtn) sendBtn.click();
        }).catch(() => {});
        await page.keyboard.press('Enter');
      }

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `GLM error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '.thinking-chain-container',
              '[class*="thinking-chain" i]',
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-bar" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const containers = Array.from(document.querySelectorAll(sel));
          const target = containers.length > initial ? (containers[containers.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true };
          const text = cleanDOMText(target);

          const stopBtn = document.querySelector('[class*="stop"], button[aria-label*="停止" i], button[aria-label*="Stop" i]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: glmResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'GLM response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `GLM execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }

  /**
   * Interact with Perplexity Web UI (perplexity.ai)
   */
  async *chatWithPerplexity(
    page: Page,
    prompt: string,
    files: FileAttachment[] = [],
    timeoutMsOrOpts: number | TypingOptions = 90000,
    options?: TypingOptions,
  ): AsyncIterable<StreamEvent> {
    const opts = typeof timeoutMsOrOpts === 'object' ? timeoutMsOrOpts : options;
    const timeoutMs = typeof timeoutMsOrOpts === 'number' ? timeoutMsOrOpts : 90000;
    try {
      if (!page.url().includes('perplexity.ai')) {
        await page.goto('https://www.perplexity.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
      await page.bringToFront().catch(() => {});
      await page.waitForTimeout(1000);

      // Check login
      if (page.url().includes('/login') || page.url().includes('/signin')) {
        const scene = await this.captureErrorScene(page, 'Perplexity requires login.');
        yield { type: 'error', message: 'Perplexity is not logged in. Please log in first.', scene } as any;
        return;
      }

      const inputSelector = 'textarea[placeholder*="Ask" i], textarea[placeholder*="anything" i], textarea, div[contenteditable="true"]';
      const inputEl = await page.waitForSelector(inputSelector, { state: 'visible', timeout: 20000 }).catch(() => null);

      if (!inputEl) {
        const scene = await this.captureErrorScene(page, 'Perplexity input box not found.');
        yield { type: 'error', message: 'Perplexity input box not found. Check if tab is ready.', scene } as any;
        return;
      }

      if (files.length > 0) {
        const prep = await this.validateAndPrepareFiles(page, files, 'Perplexity');
        if (!prep.success) {
          if (prep.errorEvent) yield prep.errorEvent;
          return;
        }
        const upload = await this.uploadFilesToInput(page, prep.validPaths, 'Perplexity');
        if (!upload.success) {
          if (upload.errorEvent) yield upload.errorEvent;
          return;
        }
      }

      const perplexityResponseSelector = 'div.prose, [dir="auto"].break-words, div.default.font-sans';
      const initialCount = await page.evaluate((sel) => {
        return document.querySelectorAll(sel).length;
      }, perplexityResponseSelector);

      const inputLocator = page.locator(inputSelector).first();
      await inputLocator.click();
      await page.waitForTimeout(200);

      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await this.enterPrompt(page, prompt, opts?.typingDelayMs);
      await page.waitForTimeout(300);

      // Submit prompt by pressing Enter directly as requested, avoiding clicks on icon buttons that open new tabs
      await inputLocator.press('Enter').catch(async () => {
        await page.keyboard.press('Enter');
      });

      let accumulatedText = '';
      const startTime = Date.now();
      let lastTextChange = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        await page.waitForTimeout(250);

        if (accumulatedText.length === 0) {
          const pageError = await this.detectPageError(page);
          if (pageError) {
            const scene = await this.captureErrorScene(page, pageError);
            yield { type: 'error', message: `Perplexity error: ${pageError}`, scene } as any;
            return;
          }
        }

        const status = await page.evaluate(({ initial, sel }) => {
          const cleanDOMText = (target: HTMLElement | null): string => {
            if (!target) return '';
            const clone = target.cloneNode(true) as HTMLElement;
            const selectorsToRemove = [
              '[class*="think" i]',
              '[class*="thought" i]',
              '[class*="reasoning" i]',
              '[data-testid*="think" i]',
              '[data-testid*="thought" i]',
              '[data-testid*="reasoning" i]',
              '[data-test-id*="think" i]',
              '[data-test-id*="thought" i]',
              '[data-test-id*="reasoning" i]',
              'model-thoughts',
              '.ds-think',
              'details',
              'summary',
              '[class*="collapse" i]',
              '[data-testid*="artifact" i]',
              '[class*="artifact" i]',
              '[data-testid*="tool" i]',
              '[class*="tool" i]',
              '[class*="plugin" i]',
              '[class*="search-process" i]',
              '[class*="search-status" i]',
              '[class*="search-result" i]',
              '[class*="ref-item" i]',
              '[class*="citation-badge" i]',
              'button',
              'svg',
              '[role="button"]',
              '[aria-label*="Copy" i]',
              '[aria-label*="copy" i]',
              '[class*="copy-button" i]',
              '[class*="copy-btn" i]',
              '[class*="action-buttons" i]',
              '[class*="action-bar" i]',
              '[class*="message-actions" i]',
              '[class*="toolbar" i]',
              '[class*="feedback" i]',
              '[class*="vote" i]',
              '[class*="avatar" i]',
            ];
            selectorsToRemove.forEach((s) => {
              clone.querySelectorAll(s).forEach((el) => el.remove());
            });
            let raw = (clone.textContent || '');
            raw = raw.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '');
            raw = raw.replace(/<thought>[\s\S]*?(?:<\/thought>|$)/gi, '');
            raw = raw.replace(/<reasoning>[\s\S]*?(?:<\/reasoning>|$)/gi, '');
            raw = raw
              .replace(/^(?:Thought for \d+ seconds|Thinking Process:?|Thinking\.\.\.|Thought:?)\s*/i, '')
              .replace(/^(?:Constructing|Building|Using tool|Searching|Thinking)[^\n]*\n?/gm, '')
              .trim();
            return raw;
          };

          const answers = Array.from(document.querySelectorAll(sel));
          const target = answers.length > initial ? (answers[answers.length - 1] as HTMLElement) : null;
          if (!target) return { text: '', isGenerating: true };
          const text = cleanDOMText(target);

          const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
          const isGenerating = !!stopBtn;

          return { text, isGenerating };
        }, { initial: initialCount, sel: perplexityResponseSelector });

        if (status.text) {
          status.text = sanitizeResponseText(status.text);
        }

        if (status.text && status.text.length > accumulatedText.length) {
          const delta = status.text.slice(accumulatedText.length);
          accumulatedText = status.text;
          lastTextChange = Date.now();
          yield { type: 'text_delta', delta };
        }

        if (accumulatedText.length > 0 && !status.isGenerating && Date.now() - lastTextChange > 2500) {
          yield { type: 'done', reason: 'stop' };
          return;
        }
      }

      if (accumulatedText.length === 0) {
        const pageError = await this.detectPageError(page);
        const errorMsg = pageError || 'Perplexity response timed out without text output.';
        const scene = await this.captureErrorScene(page, errorMsg);
        yield { type: 'error', message: errorMsg, scene } as any;
        return;
      }

      yield { type: 'done', reason: 'stop' };
    } catch (err) {
      const scene = await this.captureErrorScene(page, (err as Error).message);
      yield { type: 'error', message: `Perplexity execution error: ${(err as Error).message}`, scene } as any;
    } finally {
      this.safeRelease(page);
    }
  }
}
