import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';
import { BrowserUIDriver } from '../../browser/ui-driver.js';

export class PerplexityProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'perplexity-web',
    name: 'Perplexity Web',
    website: 'https://www.perplexity.ai',
    loginUrl: 'https://www.perplexity.ai',
    needsBrowser: true,
  };

  private uiDriver?: BrowserUIDriver;

  constructor(
    public authStore: AuthStore,
    _browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
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
      { id: 'perplexity-default', name: 'Perplexity', contextWindow: 128000, maxOutput: 4096 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const prompt = buildWebPrompt(req.messages);

    if (this.getPage && this.uiDriver) {
      let page: any = null;
      try {
        page = await this.getPage('https://www.perplexity.ai');
        yield* this.uiDriver.chatWithPerplexity(page, prompt, req.files, { typingDelayMs: req.typingDelayMs });
        return;
      } catch (err) {
        console.warn('[PerplexityProvider] UI driver error:', (err as Error).message);
        yield { type: 'error', message: `Perplexity error: ${(err as Error).message}` };
        return;
      } finally {
        page?.release?.();
      }
    }

    yield { type: 'error', message: 'Browser not connected' };
  }
}
