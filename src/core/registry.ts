import { BaseProvider, type ModelInfo } from './provider.js';
import { InvalidModelError } from './errors.js';
import { ModelDiscoveryService, PROVIDERS_CATALOG } from './model-discovery.js';

export interface ProviderStatus {
  id: string;
  name: string;
  website: string;
  authenticated: boolean;
  modelCount: number;
}

const PROVIDER_ALIASES: Record<string, { providerId: string; defaultModel: string }> = {
  'gemini': { providerId: 'gemini-web', defaultModel: 'gemini-3-flash' },
  'google-gemini': { providerId: 'gemini-web', defaultModel: 'gemini-3-flash' },
  'google': { providerId: 'gemini-web', defaultModel: 'gemini-3-flash' },
  'gemini-web': { providerId: 'gemini-web', defaultModel: 'gemini-3-flash' },

  'chatgpt': { providerId: 'chatgpt-web', defaultModel: 'gpt-5.4-mini' },
  'openai-chatgpt': { providerId: 'chatgpt-web', defaultModel: 'gpt-5.4-mini' },
  'openai': { providerId: 'chatgpt-web', defaultModel: 'gpt-5.4-mini' },
  'chatgpt-web': { providerId: 'chatgpt-web', defaultModel: 'gpt-5.4-mini' },

  'claude': { providerId: 'claude-web', defaultModel: 'claude-sonnet-4-6' },
  'anthropic-claude': { providerId: 'claude-web', defaultModel: 'claude-sonnet-4-6' },
  'anthropic': { providerId: 'claude-web', defaultModel: 'claude-sonnet-4-6' },
  'claude-web': { providerId: 'claude-web', defaultModel: 'claude-sonnet-4-6' },

  'deepseek': { providerId: 'deepseek-web', defaultModel: 'deepseek-v4' },
  'deepseek-ai': { providerId: 'deepseek-web', defaultModel: 'deepseek-v4' },
  'deepseek-web': { providerId: 'deepseek-web', defaultModel: 'deepseek-v4' },

  'grok': { providerId: 'grok-web', defaultModel: 'grok-3' },
  'xai': { providerId: 'grok-web', defaultModel: 'grok-3' },
  'grok-web': { providerId: 'grok-web', defaultModel: 'grok-3' },

  'perplexity': { providerId: 'perplexity-web', defaultModel: 'sonar-pro' },
  'perplexity-web': { providerId: 'perplexity-web', defaultModel: 'sonar-pro' },

  'kimi': { providerId: 'kimi-web', defaultModel: 'kimi-k2.5' },
  'kimi-web': { providerId: 'kimi-web', defaultModel: 'kimi-k2.5' },

  'qwen': { providerId: 'qwen-web', defaultModel: 'qwen-3.5-plus' },
  'qwen-web': { providerId: 'qwen-web', defaultModel: 'qwen-3.5-plus' },

  'glm': { providerId: 'glm-web', defaultModel: 'glm-5' },
  'glm-web': { providerId: 'glm-web', defaultModel: 'glm-5' },
};

export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();
  readonly discoveryService: ModelDiscoveryService;

  constructor(discoveryService?: ModelDiscoveryService) {
    this.discoveryService = discoveryService || new ModelDiscoveryService();
  }

  register(provider: BaseProvider): void {
    this.providers.set(provider.info.id, provider);
  }

  async resolve(modelId: string): Promise<{ provider: BaseProvider; model: string }> {
    const cleanId = modelId.trim().toLowerCase();

    // 1. Check if modelId is a top-level provider name / alias (e.g. "gemini", "chatgpt", "claude")
    if (PROVIDER_ALIASES[cleanId]) {
      const alias = PROVIDER_ALIASES[cleanId];
      const provider = this.providers.get(alias.providerId);
      if (provider) {
        return { provider, model: alias.defaultModel };
      }
    }

    const slashIndex = modelId.indexOf('/');

    // 2. Explicit provider/model format (e.g. "gemini-web/gemini-3-flash")
    if (slashIndex > 0 && slashIndex < modelId.length - 1) {
      const providerId = modelId.slice(0, slashIndex);
      const model = modelId.slice(slashIndex + 1);

      // Check direct provider ID or alias
      const resolvedProviderId = PROVIDER_ALIASES[providerId.toLowerCase()]?.providerId || providerId;
      const provider = this.providers.get(resolvedProviderId) || this.providers.get(providerId);
      if (provider) {
        return { provider, model };
      }
    }

    // 3. Fuzzy match: search all providers for a model with this ID
    for (const [, provider] of this.providers) {
      const models = await provider.models();
      if (models.some((m) => m.id === modelId)) {
        return { provider, model: modelId };
      }
    }

    // 4. If still not matched, check if any provider handles this model prefix
    for (const [providerId, provider] of this.providers) {
      if (modelId.toLowerCase().startsWith(providerId.replace('-web', ''))) {
        return { provider, model: modelId };
      }
    }

    throw new InvalidModelError(modelId);
  }

  /**
   * Return models based on current Model Option setting:
   * 'off': Returns high-level provider catalog (Google Gemini, ChatGPT, Claude, etc.)
   * 'on': Returns full granular model list across all registered providers
   */
  async allModels(overrideOption?: 'off' | 'on'): Promise<(ModelInfo & { id: string })[]> {
    const mode = overrideOption ?? this.discoveryService.getModelOption();

    if (mode === 'off') {
      // Model Option OFF: Return providers as models
      return PROVIDERS_CATALOG.map((p) => ({
        id: p.id,
        name: p.name,
        contextWindow: 1000000,
        maxOutput: 8192,
      }));
    }

    // Model Option ON: Return granular model list for all registered providers
    const result: (ModelInfo & { id: string })[] = [];

    for (const [providerId, provider] of this.providers) {
      if (!(await provider.isAuthenticated())) continue;
      const models = await provider.models();
      for (const m of models) {
        result.push({ ...m, id: `${providerId}/${m.id}` });
      }
    }

    // If providers list is empty and no providers registered, return defaults from discovery catalog
    if (result.length === 0 && this.providers.size === 0) {
      return this.discoveryService.getAllDetailedModels();
    }

    return result;
  }

  async providerStatus(): Promise<ProviderStatus[]> {
    const result: ProviderStatus[] = [];

    for (const [, provider] of this.providers) {
      const authenticated = await provider.isAuthenticated();
      let modelCount = 0;
      if (authenticated) {
        modelCount = (await provider.models()).length;
      }
      result.push({
        id: provider.info.id,
        name: provider.info.name,
        website: provider.info.website,
        authenticated,
        modelCount,
      });
    }

    return result;
  }

  getProvider(id: string): BaseProvider | undefined {
    return this.providers.get(id);
  }

  getAllProviders(): BaseProvider[] {
    return Array.from(this.providers.values());
  }
}
