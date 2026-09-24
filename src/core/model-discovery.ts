import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ModelInfo } from './provider.js';

export interface ProviderCatalogItem {
  id: string; // e.g. "gemini", "chatgpt"
  name: string; // e.g. "Google Gemini"
  description: string;
  defaultModel: string;
  website: string;
}

// Top-level providers when Model Option is OFF
export const PROVIDERS_CATALOG: ProviderCatalogItem[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google DeepMind multimodal AI with web reasoning & vision',
    defaultModel: 'gemini-3-flash',
    website: 'https://gemini.google.com',
  },
  {
    id: 'chatgpt',
    name: 'OpenAI ChatGPT',
    description: 'OpenAI ChatGPT with advanced reasoning & GPT-5 / GPT-4o models',
    defaultModel: 'gpt-5.4-mini',
    website: 'https://chatgpt.com',
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    description: 'Anthropic Claude with exceptional coding, analysis & Claude 3.7 / 4',
    defaultModel: 'claude-sonnet-4-6',
    website: 'https://claude.ai',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek AI',
    description: 'DeepSeek V3 & R1 reasoning and code generation models',
    defaultModel: 'deepseek-v4',
    website: 'https://chat.deepseek.com',
  },
  {
    id: 'grok',
    name: 'xAI Grok',
    description: 'xAI Grok real-time conversational model with web access',
    defaultModel: 'grok-3',
    website: 'https://grok.com',
  },
  {
    id: 'perplexity',
    name: 'Perplexity AI',
    description: 'Perplexity Sonar search and citation-backed synthesis engine',
    defaultModel: 'sonar-pro',
    website: 'https://www.perplexity.ai',
  },
  {
    id: 'kimi',
    name: 'Moonshot Kimi',
    description: 'Ultra-long context Kimi AI',
    defaultModel: 'kimi-k2.5',
    website: 'https://kimi.ai',
  },
  {
    id: 'qwen',
    name: 'Alibaba Qwen',
    description: 'Qwen multi-lingual open-weights leader by Alibaba Cloud',
    defaultModel: 'qwen-3.5-plus',
    website: 'https://qwen.ai',
  },
  {
    id: 'glm',
    name: 'Zhipu GLM',
    description: 'GLM flagship foundation model by Zhipu AI',
    defaultModel: 'glm-5',
    website: 'https://chatglm.com',
  },
];

// Granular models when Model Option is ON
export const DEFAULT_DETAILED_MODELS: Record<string, ModelInfo[]> = {
  'gemini-web': [
    { id: 'gemini-3-flash', name: 'Gemini 3 Flash (High-Speed Multimodal)', contextWindow: 1000000, maxOutput: 8192 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Deep Reasoning & Vision)', contextWindow: 2000000, maxOutput: 8192 },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1000000, maxOutput: 8192 },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1000000, maxOutput: 8192 },
    { id: 'gemini-exp', name: 'Gemini Experimental Preview', contextWindow: 1000000, maxOutput: 8192 },
  ],
  'chatgpt-web': [
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 128000, maxOutput: 4096 },
    { id: 'gpt-5.3', name: 'GPT-5.3 Flagship', contextWindow: 200000, maxOutput: 8192 },
    { id: 'gpt-4o', name: 'GPT-4o Omni', contextWindow: 128000, maxOutput: 4096 },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, maxOutput: 4096 },
    { id: 'o1', name: 'OpenAI o1 Reasoning', contextWindow: 200000, maxOutput: 8192 },
    { id: 'o3-mini', name: 'OpenAI o3-mini Reasoning', contextWindow: 200000, maxOutput: 8192 },
  ],
  'claude-web': [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000, maxOutput: 8192 },
    { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet (Hybrid Reasoning)', contextWindow: 200000, maxOutput: 8192 },
    { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000, maxOutput: 8192 },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxOutput: 8192 },
    { id: 'claude-3-5-haiku', name: 'Claude 3.5 Haiku', contextWindow: 200000, maxOutput: 8192 },
  ],
  'deepseek-web': [
    { id: 'deepseek-v4', name: 'DeepSeek V4 Chat', contextWindow: 128000, maxOutput: 8192 },
    { id: 'deepseek-v4-reasoner', name: 'DeepSeek V4 Reasoner (R2)', contextWindow: 128000, maxOutput: 8192 },
    { id: 'deepseek-v3', name: 'DeepSeek V3 Chat', contextWindow: 128000, maxOutput: 8192 },
    { id: 'deepseek-r1', name: 'DeepSeek R1 Reasoner', contextWindow: 128000, maxOutput: 8192 },
  ],
  'grok-web': [
    { id: 'grok-3', name: 'Grok 3 (Full Reasoning)', contextWindow: 128000, maxOutput: 8192 },
    { id: 'grok-3-mini', name: 'Grok 3 Mini', contextWindow: 128000, maxOutput: 4096 },
    { id: 'grok-2', name: 'Grok 2 Web', contextWindow: 128000, maxOutput: 4096 },
  ],
  'perplexity-web': [
    { id: 'sonar-pro', name: 'Sonar Pro Search & Synthesis', contextWindow: 200000, maxOutput: 8192 },
    { id: 'sonar', name: 'Sonar Search', contextWindow: 128000, maxOutput: 4096 },
    { id: 'sonar-reasoning', name: 'Sonar Deep Research & Reasoning', contextWindow: 200000, maxOutput: 8192 },
  ],
  'kimi-web': [
    { id: 'kimi-k2.5', name: 'Kimi K2.5 High-Context', contextWindow: 2000000, maxOutput: 8192 },
    { id: 'kimi-k1.5', name: 'Kimi K1.5 Long Context', contextWindow: 1000000, maxOutput: 8192 },
  ],
  'qwen-web': [
    { id: 'qwen-3.5-plus', name: 'Qwen 3.5 Plus', contextWindow: 128000, maxOutput: 8192 },
    { id: 'qwen-2.5-max', name: 'Qwen 2.5 Max', contextWindow: 128000, maxOutput: 8192 },
  ],
  'glm-web': [
    { id: 'glm-5', name: 'GLM 5 Enterprise', contextWindow: 128000, maxOutput: 8192 },
    { id: 'glm-4-plus', name: 'GLM 4 Plus', contextWindow: 128000, maxOutput: 8192 },
  ],
};

export class ModelDiscoveryService {
  private cachePath: string;
  private discoveredModels: Record<string, ModelInfo[]> = {};
  private modelOption: 'off' | 'on' = 'off'; // Default: 'off' (Providers Mode)

  constructor(stateDir?: string) {
    const base = stateDir || join(process.cwd(), '.webmodel');
    this.cachePath = join(base, 'discovered-models.json');
    this.load();
  }

  getModelOption(): 'off' | 'on' {
    return this.modelOption;
  }

  setModelOption(val: 'off' | 'on'): void {
    this.modelOption = val;
  }

  /**
   * Get all provider-level models (when Model Option is OFF)
   */
  getProviderModels(): Array<{ id: string; name: string; description: string; contextWindow: number; maxOutput: number }> {
    return PROVIDERS_CATALOG.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      contextWindow: 1000000,
      maxOutput: 8192,
    }));
  }

  /**
   * Get all granular models for a provider, merging defaults with dynamically discovered models
   */
  getModelsForProvider(providerId: string): ModelInfo[] {
    const defaults = DEFAULT_DETAILED_MODELS[providerId] || [];
    const custom = this.discoveredModels[providerId] || [];
    const map = new Map<string, ModelInfo>();

    for (const m of defaults) map.set(m.id, m);
    for (const m of custom) map.set(m.id, m);

    return Array.from(map.values());
  }

  /**
   * Returns all granular models across all providers
   */
  getAllDetailedModels(): Array<ModelInfo & { id: string }> {
    const result: Array<ModelInfo & { id: string }> = [];

    for (const [providerId] of Object.entries(DEFAULT_DETAILED_MODELS)) {
      const models = this.getModelsForProvider(providerId);
      for (const m of models) {
        result.push({
          ...m,
          id: `${providerId}/${m.id}`,
        });
      }
    }

    return result;
  }

  /**
   * Add newly discovered models dynamically
   */
  registerDiscoveredModels(providerId: string, models: ModelInfo[]): void {
    if (!this.discoveredModels[providerId]) {
      this.discoveredModels[providerId] = [];
    }

    const existingIds = new Set(this.discoveredModels[providerId].map(m => m.id));
    for (const m of models) {
      if (!existingIds.has(m.id)) {
        this.discoveredModels[providerId].push(m);
      }
    }

    this.save();
  }

  /**
   * Perform dynamic discovery across providers
   * If a Playwright Page is supplied for a provider, inspects the DOM for model selector dropdowns!
   */
  async discoverFromPage(providerId: string, page: any): Promise<ModelInfo[]> {
    if (!page || typeof page.evaluate !== 'function') {
      return this.getModelsForProvider(providerId);
    }

    try {
      const discovered = await page.evaluate(() => {
        const found: Array<{ id: string; name: string }> = [];
        // Gemini model picker
        const geminiOptions = document.querySelectorAll('mat-select mat-option, [data-test-id="model-selector-option"], .model-select-option');
        geminiOptions.forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && text.length < 50) {
            const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            found.push({ id, name: text });
          }
        });

        // ChatGPT model dropdown items
        const gptOptions = document.querySelectorAll('[role="menuitemradio"], [data-testid*="model-selector-"]');
        gptOptions.forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && text.length < 50) {
            const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            found.push({ id, name: text });
          }
        });

        // Claude model selector
        const claudeOptions = document.querySelectorAll('[data-testid="model-selector-option"], [role="option"]');
        claudeOptions.forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && text.length < 50) {
            const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            found.push({ id, name: text });
          }
        });

        // DeepSeek model buttons
        const deepseekOptions = document.querySelectorAll('.ds-segmented-item, button[class*="model"]');
        deepseekOptions.forEach(el => {
          const text = (el.textContent || '').trim();
          if (text && text.length < 50 && (text.includes('DeepSeek') || text.includes('V3') || text.includes('R1'))) {
            const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            found.push({ id, name: text });
          }
        });

        return found;
      });

      if (Array.isArray(discovered) && discovered.length > 0) {
        const modelInfos: ModelInfo[] = discovered.map(d => ({
          id: d.id,
          name: d.name,
          contextWindow: 1000000,
          maxOutput: 8192,
        }));
        this.registerDiscoveredModels(providerId, modelInfos);
        return this.getModelsForProvider(providerId);
      }
    } catch {
      // Ignore DOM discovery errors
    }

    return this.getModelsForProvider(providerId);
  }

  private load(): void {
    try {
      if (existsSync(this.cachePath)) {
        const raw = readFileSync(this.cachePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.discoveredModels) this.discoveredModels = parsed.discoveredModels;
        if (parsed.modelOption) this.modelOption = parsed.modelOption;
      }
    } catch {
      // Ignore
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(
        this.cachePath,
        JSON.stringify({ discoveredModels: this.discoveredModels, modelOption: this.modelOption }, null, 2),
        'utf-8',
      );
    } catch {
      // Ignore
    }
  }
}
