import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeStandardSSE } from '../_shared/standard-stream.js';
import { readSSE } from '../_shared/sse-reader.js';
import { GROK_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import { BrowserUIDriver } from '../../browser/ui-driver.js';
import type { Page } from 'playwright-core';

export class GrokProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'grok-web',
    name: 'Grok Web',
    website: 'https://grok.com',
    loginUrl: 'https://grok.com',
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
      { id: 'grok-3', name: 'Grok 3 (Reasoning & Real-time Web)', contextWindow: 131072, maxOutput: 8192 },
      { id: 'grok-2', name: 'Grok 2', contextWindow: 131072, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const prompt = buildWebPrompt(req.messages);

    // 1. If getPage is available, use BrowserUIDriver for direct typing/sending on grok.com
    if (this.getPage && this.uiDriver) {
      let page: any = null;
      try {
        page = await this.getPage('https://grok.com');
        yield* this.uiDriver.chatWithGrok(page, prompt, req.files, { typingDelayMs: req.typingDelayMs });
        return;
      } catch (err) {
        console.warn('[GrokProvider] UI driver error, falling back:', (err as Error).message);
      } finally {
        page?.release?.();
      }
    }

    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const response = await this.browserFetch(`${GROK_WEB_BASE_URL}/api/chat/completions`, {
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
      yield { type: 'error', message: `Grok error: ${(err as Error).message}` };
    }
  }
}
