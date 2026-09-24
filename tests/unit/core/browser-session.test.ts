import { describe, it, expect } from 'vitest';
import { BrowserManager } from '../../../src/browser/manager.js';
import { GLMProvider } from '../../../src/providers/glm-web/index.js';
import { KimiProvider } from '../../../src/providers/kimi-web/index.js';
import { AuthStore } from '../../../src/auth/store.js';

describe('BrowserManager Session & Auth Detection', () => {
  const bm = new BrowserManager({
    profileDir: '/tmp/test-profile',
    startupTimeout: 5000,
    idleShutdown: 0,
    loginTimeout: 10,
    mode: 'attach',
  });

  it('detects session cookies for Kimi on moonshot.cn and kimi.ai', () => {
    const cookies1 = [{ domain: '.moonshot.cn', name: 'token', value: 'secret-token' }];
    expect(bm.hasSessionCookies(cookies1, 'kimi-web')).toBe(true);

    const cookies2 = [{ domain: 'kimi.ai', name: 'access_token', value: 'secret-token' }];
    expect(bm.hasSessionCookies(cookies2, 'kimi-web')).toBe(true);

    const cookies3 = [{ domain: 'other.com', name: 'token', value: 'secret-token' }];
    expect(bm.hasSessionCookies(cookies3, 'kimi-web')).toBe(false);
  });

  it('detects session cookies for Gemini on google.com and gemini.google.com', () => {
    const cookies = [{ domain: '.google.com', name: 'SID', value: 'sid-val' }];
    expect(bm.hasSessionCookies(cookies, 'gemini-web')).toBe(true);

    const cookiesSecure = [{ domain: '.gemini.google.com', name: '__Secure-1PSID', value: 'secure-sid' }];
    expect(bm.hasSessionCookies(cookiesSecure, 'gemini-web')).toBe(true);
  });

  it('detects session cookies for GLM on z.ai and chatglm.cn', () => {
    const cookiesZai = [{ domain: 'z.ai', name: 'token', value: 'zai-token' }];
    expect(bm.hasSessionCookies(cookiesZai, 'glm-web')).toBe(true);

    const cookiesChatglm = [{ domain: '.chatglm.cn', name: 'chatglm_token', value: 'glm-token' }];
    expect(bm.hasSessionCookies(cookiesChatglm, 'glm-web')).toBe(true);
  });

  it('detects isPageAuthenticated on target URLs', async () => {
    const mockPageGemini = {
      isClosed: () => false,
      url: () => 'https://gemini.google.com/app',
      $: async () => ({}),
    } as any;
    expect(await bm.isPageAuthenticated(mockPageGemini, 'gemini-web')).toBe(true);

    const mockPageGeminiLogin = {
      isClosed: () => false,
      url: () => 'https://accounts.google.com/signin',
      $: async () => null,
    } as any;
    expect(await bm.isPageAuthenticated(mockPageGeminiLogin, 'gemini-web')).toBe(false);

    const mockPageClaude = {
      isClosed: () => false,
      url: () => 'https://claude.ai/chat/12345',
      $: async () => ({}),
    } as any;
    expect(await bm.isPageAuthenticated(mockPageClaude, 'claude-web')).toBe(true);

    const mockPageClaudeLogin = {
      isClosed: () => false,
      url: () => 'https://claude.ai/login',
      $: async () => null,
    } as any;
    expect(await bm.isPageAuthenticated(mockPageClaudeLogin, 'claude-web')).toBe(false);

    const mockPageQwen = {
      isClosed: () => false,
      url: () => 'https://chat.qwen.ai/',
      $: async () => ({}),
    } as any;
    expect(await bm.isPageAuthenticated(mockPageQwen, 'qwen-web')).toBe(true);

    const mockPageGLM = {
      isClosed: () => false,
      url: () => 'https://z.ai/c/new',
      $: async () => ({}),
    } as any;
    expect(await bm.isPageAuthenticated(mockPageGLM, 'glm-web')).toBe(true);
  });

  it('GLM provider defaults to official global URL https://chat.z.ai', () => {
    const dummyStore = new AuthStore('/tmp/dummy');
    const glm = new GLMProvider(dummyStore);
    expect(glm.info.website).toBe('https://chat.z.ai');
    expect(glm.info.loginUrl).toBe('https://chat.z.ai');
  });

  it('Kimi provider defaults to official global URL https://www.kimi.ai', () => {
    const dummyStore = new AuthStore('/tmp/dummy');
    const kimi = new KimiProvider(dummyStore);
    expect(kimi.info.website).toBe('https://www.kimi.ai');
    expect(kimi.info.loginUrl).toBe('https://www.kimi.ai');
  });
});
