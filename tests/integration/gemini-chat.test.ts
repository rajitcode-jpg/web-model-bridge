import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../helpers/test-server.js';
import { MockProvider } from '../helpers/mock-provider.js';

describe('Gemini Web Model Integration', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.cleanup());

  it('lists gemini-web models when provider is registered and authenticated', async () => {
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [
        { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, maxOutput: 8192 },
      ],
    });

    ctx = createTestContext({ providers: [gemini] });

    const res = await ctx.app.request('/v1/models');
    expect(res.status).toBe(200);

    const body = await res.json();
    const modelIds = body.data.map((m: any) => m.id);
    expect(modelIds).toContain('gemini-web/gemini-3-flash');
    expect(modelIds).toContain('gemini-web/gemini-2.5-pro');
  });

  it('lists providers when mode=providers or mode=off', async () => {
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 }],
    });

    ctx = createTestContext({ providers: [gemini] });

    const res = await ctx.app.request('/v1/models?mode=providers');
    expect(res.status).toBe(200);

    const body = await res.json();
    const ids = body.data.map((m: any) => m.id);
    expect(ids).toContain('gemini');
    expect(ids).toContain('chatgpt');
    expect(ids).toContain('claude');
  });

  it('completes chat request with model alias "gemini" directly', async () => {
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 }],
    });

    ctx = createTestContext({ providers: [gemini] });

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini',
        messages: [{ role: 'user', content: 'What is the speed of light?' }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('gemini');
    expect(body.choices[0].message.role).toBe('assistant');
  });

  it('handles multimodal file attachments in chat completions', async () => {
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 }],
    });

    ctx = createTestContext({ providers: [gemini] });

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini',
        messages: [{ role: 'user', content: 'Analyze this image and document' }],
        files: [
          { name: 'photo.png', type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
          { name: 'document.pdf', type: 'application/pdf', data: 'JVBERi0xLjQK' },
        ],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBeDefined();
  });

  it('auto-converts prompts >= 25,000 words into a document file', async () => {
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 }],
    });

    ctx = createTestContext({ providers: [gemini] });

    const hugePrompt = Array.from({ length: 25010 }, (_, i) => `token${i}`).join(' ');

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini',
        messages: [{ role: 'user', content: hugePrompt }],
        stream: false,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auto_converted_file).toBe(true);
  });

  it('streams chat response with gemini-web/gemini-2.5-pro', async () => {
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, maxOutput: 8192 }],
    });

    ctx = createTestContext({ providers: [gemini] });

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-web/gemini-2.5-pro',
        messages: [{ role: 'user', content: 'Count to 3' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: ');
    expect(text).toContain('[DONE]');
  });

  it('returns 401 when gemini-web is unauthenticated', async () => {
    const gemini = new MockProvider('gemini-web', { authenticated: false });
    ctx = createTestContext({ providers: [gemini] });

    const res = await ctx.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-web/gemini-3-flash',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('auth_required');
  });
});
