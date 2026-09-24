import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeChatGPTSSE } from './stream.js';
import { readSSE } from '../_shared/sse-reader.js';
import { CHATGPT_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import { BrowserUIDriver } from '../../browser/ui-driver.js';
import type { Page } from 'playwright-core';

export class ChatGPTProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'chatgpt-web',
    name: 'ChatGPT Web',
    website: 'https://chatgpt.com',
    loginUrl: 'https://chatgpt.com/auth/login',
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
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 128000, maxOutput: 4096 },
      { id: 'gpt-5.3', name: 'GPT-5.3', contextWindow: 200000, maxOutput: 8192 },
      { id: 'gpt-4o', name: 'GPT-4o Omni', contextWindow: 128000, maxOutput: 4096 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, maxOutput: 4096 },
      { id: 'o1', name: 'OpenAI o1', contextWindow: 200000, maxOutput: 8192 },
      { id: 'o3-mini', name: 'OpenAI o3-mini', contextWindow: 200000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const prompt = buildWebPrompt(req.messages);

    if (this.getPage && this.uiDriver) {
      let page: any = null;
      try {
        page = await this.getPage('https://chatgpt.com');
        yield* this.uiDriver.chatWithChatGPT(page, prompt, req.files, { typingDelayMs: req.typingDelayMs });
        return;
      } catch (err) {
        console.warn('[ChatGPTProvider] UI driver error, falling back:', (err as Error).message);
      } finally {
        page?.release?.();
      }
    }

    if (!this.browserFetch) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const response = await this.browserFetch(
        `${CHATGPT_WEB_BASE_URL}/backend-api/conversation`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: req.model,
            messages: [{
              author: { role: 'user' },
              content: { content_type: 'text', parts: [prompt] },
            }],
          }),
        }
      );

      yield* readSSE(response, normalizeChatGPTSSE);
    } catch (err) {
      yield { type: 'error', message: `ChatGPT error: ${(err as Error).message}` };
    }
  }
}
