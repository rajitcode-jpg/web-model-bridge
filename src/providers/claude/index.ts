import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';
import { normalizeClaudeSSE } from './stream.js';
import { AuthStore } from '../../auth/store.js';
import { BrowserUIDriver } from '../../browser/ui-driver.js';
import type { Page } from 'playwright-core';

const BASE_URL = 'https://claude.ai';

export class ClaudeProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'claude-web',
    name: 'Claude Web',
    website: BASE_URL,
    loginUrl: `${BASE_URL}/login`,
    needsBrowser: true,
  };

  private organizationId: string | null = null;
  private deviceId: string | null = null;
  private uiDriver?: BrowserUIDriver;

  constructor(
    public authStore: AuthStore,
    browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
  ) {
    void browserFetch;
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
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000, maxOutput: 8192 },
      { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet (Hybrid Reasoning)', contextWindow: 200000, maxOutput: 8192 },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000, maxOutput: 8192 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    const prompt = buildWebPrompt(req.messages);

    let page: any = null;
    try {
      page = await this.getPage(BASE_URL);

      // Try UI driver first for direct typing/sending on claude.ai
      if (this.uiDriver) {
        let emittedAny = false;
        for await (const ev of this.uiDriver.chatWithClaude(page, prompt, req.files, { typingDelayMs: req.typingDelayMs })) {
          yield ev;
          emittedAny = true;
        }
        if (emittedAny) return;
      }

      // Step 1: Get organizationId (cached)
      if (!this.organizationId) {
        const orgResult = await page.evaluate(async (deviceId: string) => {
          try {
            const res = await fetch('/api/organizations', {
              headers: {
                'Content-Type': 'application/json',
                'anthropic-client-platform': 'web_claude_ai',
                'anthropic-device-id': deviceId,
              },
              credentials: 'include',
            });
            if (!res.ok) return { error: `HTTP ${res.status}` };
            const data = await res.json();
            return { orgs: data };
          } catch (e: any) {
            return { error: e.message };
          }
        }, this.deviceId ?? crypto.randomUUID());

        if (orgResult.error) {
          yield { type: 'error', message: `Claude API notice: ${orgResult.error}` };
          return;
        }

        const orgs = orgResult.orgs;
        if (!Array.isArray(orgs) || orgs.length === 0) {
          yield { type: 'error', message: 'No organizations found in Claude session.' };
          return;
        }
        this.organizationId = orgs[0].uuid;
        this.deviceId = this.deviceId ?? crypto.randomUUID();
      }

      // Step 2: Create conversation
      const convUuid = crypto.randomUUID();
      const convResult = await page.evaluate(async (args: { apiBase: string; orgId: string; deviceId: string; convUuid: string }) => {
        try {
          const res = await fetch(`${args.apiBase}/organizations/${args.orgId}/chat_conversations`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'anthropic-client-platform': 'web_claude_ai',
              'anthropic-device-id': args.deviceId,
            },
            body: JSON.stringify({
              name: '',
              uuid: args.convUuid,
            }),
            credentials: 'include',
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const data = await res.json();
          return { conv: data };
        } catch (e: any) {
          return { error: e.message };
        }
      }, { apiBase: '/api', orgId: this.organizationId!, deviceId: this.deviceId!, convUuid });

      if (convResult.error) {
        yield { type: 'error', message: `Failed to create conversation: ${convResult.error}` };
        return;
      }

      const conversationId = convResult.conv?.uuid ?? convUuid;

      // Step 3: Send message and read SSE response
      const sseResult = await page.evaluate(async (args: {
        apiBase: string; orgId: string; convId: string; deviceId: string;
        prompt: string; model: string;
      }) => {
        try {
          const res = await fetch(
            `${args.apiBase}/organizations/${args.orgId}/chat_conversations/${args.convId}/completion`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'anthropic-client-platform': 'web_claude_ai',
                'anthropic-device-id': args.deviceId,
              },
              body: JSON.stringify({
                prompt: args.prompt,
                parent_message_uuid: '00000000-0000-4000-8000-000000000000',
                model: args.model,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                rendering_mode: 'messages',
                attachments: [],
                files: [],
                locale: 'en-US',
                personalized_styles: [],
                sync_sources: [],
                tools: [],
              }),
              credentials: 'include',
            }
          );

          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 200)}` };
          }

          const reader = res.body?.getReader();
          if (!reader) return { error: 'No response body' };

          const decoder = new TextDecoder();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
          }
          return { data: fullText };
        } catch (e: any) {
          return { error: e.message };
        }
      }, {
        apiBase: '/api',
        orgId: this.organizationId!,
        convId: conversationId,
        deviceId: this.deviceId!,
        prompt,
        model: req.model,
      });

      if (sseResult.error) {
        yield { type: 'error', message: `Claude error: ${sseResult.error}` };
        return;
      }

      const lines = (sseResult.data ?? '').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const events = normalizeClaudeSSE(trimmed);
        for (const event of events) {
          yield event;
        }
      }

    } catch (err) {
      yield { type: 'error', message: `Claude provider error: ${(err as Error).message}` };
    } finally {
      page?.release?.();
    }
  }
}
