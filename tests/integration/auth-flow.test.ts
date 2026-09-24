import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { MockProvider } from '../helpers/mock-provider.js';

describe('Auth flow integration', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('GET /webmodel/providers shows auth status', async () => {
    ctx = createTestContext({
      providers: [
        new MockProvider('p1', { authenticated: true }),
        new MockProvider('p2', { authenticated: false }),
      ],
    });
    const res = await ctx.app.request('/webmodel/providers');
    const body = await res.json();
    expect(body.providers).toHaveLength(2);
    const p1 = body.providers.find((p: any) => p.id === 'p1');
    const p2 = body.providers.find((p: any) => p.id === 'p2');
    expect(p1.authenticated).toBe(true);
    expect(p2.authenticated).toBe(false);
  });

  it('GET /webmodel/health includes provider status', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/health');
    const body = await res.json();
    expect(body.status).toBe('healthy');
    expect(body).toHaveProperty('uptime');
    expect(body).toHaveProperty('providers');
    expect(body).toHaveProperty('browser');
  });

  it('POST /webmodel/auth/login returns 503 without browser', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'claude-web' }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /webmodel/auth/login returns 404 for unknown provider', async () => {
    ctx = createTestContext();
    const res = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'nonexistent' }),
    });
    expect(res.status).toBe(404);
  });

  it('POST /webmodel/auth/login returns 200 with loginUrl when onLogin is configured', async () => {
    ctx = createTestContext({
      onLogin: async (providerId: string) => ({
        status: 'login_started',
        loginUrl: 'https://claude.ai/login',
        message: 'Opened login tab',
      }),
      getLoginState: () => ({
        providerId: 'claude-web',
        status: 'waiting_for_user',
        message: 'Waiting for user to log in',
        startedAt: Date.now(),
      }),
    });

    const res = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'claude-web' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('login_started');
    expect(body.loginUrl).toBe('https://claude.ai/login');

    const statusRes = await ctx.app.request('/webmodel/auth/login-status');
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.status).toBe('waiting_for_user');
  });

  it('supports multiple concurrent provider logins simultaneously', async () => {
    const loginStates: Record<string, any> = {
      'claude-web': { providerId: 'claude-web', status: 'waiting_for_user', message: 'Waiting for Claude', startedAt: Date.now() },
      'chatgpt-web': { providerId: 'chatgpt-web', status: 'waiting_for_user', message: 'Waiting for ChatGPT', startedAt: Date.now() },
    };

    ctx = createTestContext({
      providers: [
        new MockProvider('claude-web'),
        new MockProvider('chatgpt-web'),
      ],
      onLogin: async (providerId: string) => ({
        status: 'login_started',
        loginUrl: `https://${providerId}.com/login`,
        message: `Opened login tab for ${providerId}`,
      }),
      getLoginState: (providerId?: string) => {
        if (providerId && loginStates[providerId]) return loginStates[providerId];
        return { providerId: null, status: 'idle', message: null, startedAt: null };
      },
    });

    // 1. Start Claude login
    const res1 = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'claude-web' }),
    });
    expect(res1.status).toBe(200);
    expect((await res1.json()).loginUrl).toBe('https://claude-web.com/login');

    // 2. Start ChatGPT login simultaneously (does not block or error with "already in progress")
    const res2 = await ctx.app.request('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: 'chatgpt-web' }),
    });
    expect(res2.status).toBe(200);
    expect((await res2.json()).loginUrl).toBe('https://chatgpt-web.com/login');

    // 3. Query status for both independently
    const claudeStatusRes = await ctx.app.request('/webmodel/auth/login-status?providerId=claude-web');
    const claudeStatus = await claudeStatusRes.json();
    expect(claudeStatus.providerId).toBe('claude-web');
    expect(claudeStatus.status).toBe('waiting_for_user');

    const chatgptStatusRes = await ctx.app.request('/webmodel/auth/login-status?providerId=chatgpt-web');
    const chatgptStatus = await chatgptStatusRes.json();
    expect(chatgptStatus.providerId).toBe('chatgpt-web');
    expect(chatgptStatus.status).toBe('waiting_for_user');
  });

  it('handles simultaneous concurrent requests to multiple models in parallel', async () => {
    ctx = createTestContext({
      providers: [
        new MockProvider('claude-web', {
          authenticated: true,
          models: [{ id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000, maxOutput: 8192 }],
        }),
        new MockProvider('chatgpt-web', {
          authenticated: true,
          models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxOutput: 4096 }],
        }),
      ],
    });

    // Send requests to both models concurrently
    const [claudeRes, gptRes] = await Promise.all([
      ctx.app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet',
          messages: [{ role: 'user', content: 'Hello Claude' }],
          stream: false,
        }),
      }),
      ctx.app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hello GPT' }],
          stream: false,
        }),
      }),
    ]);

    expect(claudeRes.status).toBe(200);
    expect(gptRes.status).toBe(200);

    const claudeData = await claudeRes.json();
    const gptData = await gptRes.json();

    expect(claudeData.model).toBe('claude-3-5-sonnet');
    expect(gptData.model).toBe('gpt-4o');
    expect(claudeData.choices[0].message.content).toBeDefined();
    expect(gptData.choices[0].message.content).toBeDefined();
  });
});
