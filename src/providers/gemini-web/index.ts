import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeStandardSSE } from '../_shared/standard-stream.js';
import { readSSE } from '../_shared/sse-reader.js';
import { GEMINI_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import { BrowserUIDriver } from '../../browser/ui-driver.js';
import type { Page } from 'playwright-core';

export class GeminiProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'gemini-web',
    name: 'Gemini Web',
    website: 'https://gemini.google.com',
    loginUrl: 'https://gemini.google.com',
    needsBrowser: true,
  };

  private uiDriver?: BrowserUIDriver;

  constructor(
    public authStore: AuthStore,
    private browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
  ) {
    super();
    if (this.getPage) {
      this.uiDriver = new BrowserUIDriver(this.getPage);
    }
  }

  async login(context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    await context.openUrl(this.info.loginUrl);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authStore.getStatus(this.info.id).status === 'active';
  }

  async detectLoginComplete(): Promise<boolean> {
    return this.isAuthenticated();
  }

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'gemini-3-flash', name: 'Gemini 3 Flash (Fast Multimodal)', contextWindow: 1000000, maxOutput: 8192 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Deep Reasoning & Vision)', contextWindow: 2000000, maxOutput: 8192 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000, maxOutput: 8192 },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1000000, maxOutput: 8192 },
      { id: 'gemini-exp', name: 'Gemini Experimental', contextWindow: 1000000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const prompt = buildWebPrompt(req.messages);

    // 1. If getPage is available, use real browser UI driver to type, attach files, click send, and stream
    if (this.getPage && this.uiDriver) {
      let page: any = null;
      try {
        page = await this.getPage('https://gemini.google.com');
        yield* this.uiDriver.chatWithGemini(page, prompt, req.files, { typingDelayMs: req.typingDelayMs });
        return;
      } catch (err) {
        // Fall through to browserFetch fallback if page automation encounters unhandled failure
        console.warn('[GeminiProvider] UI driver error, falling back:', (err as Error).message);
      } finally {
        page?.release?.();
      }
    }

    // 2. Fallback to browserFetch for mock test environments
    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const response = await this.browserFetch(`${GEMINI_WEB_BASE_URL}/api/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: req.model,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
        }),
      });

      yield* readSSE(response, normalizeStandardSSE);
    } catch (err) {
      yield { type: 'error', message: `Gemini error: ${(err as Error).message}` };
    }
  }
}
