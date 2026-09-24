import { describe, it, expect } from 'vitest';
import { ModelDiscoveryService, PROVIDERS_CATALOG } from '../../../src/core/model-discovery.js';
import { ProviderRegistry } from '../../../src/core/registry.js';
import { MockProvider } from '../../helpers/mock-provider.js';

describe('model-discovery & dual mode registry', () => {
  it('loads provider catalog for mode=off', () => {
    const service = new ModelDiscoveryService();
    const providers = service.getProviderModels();
    expect(providers.length).toBe(9);
    const gemini = providers.find(p => p.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini?.name).toBe('Google Gemini');
  });

  it('registry allModels returns providers when mode=off', async () => {
    const registry = new ProviderRegistry();
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 }],
    });
    registry.register(gemini);

    const modelsOff = await registry.allModels('off');
    expect(modelsOff.length).toBe(PROVIDERS_CATALOG.length);
    expect(modelsOff.map(m => m.id)).toContain('gemini');
    expect(modelsOff.map(m => m.id)).toContain('chatgpt');
    expect(modelsOff.map(m => m.id)).toContain('claude');
  });

  it('registry allModels returns detailed models when mode=on', async () => {
    const registry = new ProviderRegistry();
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [
        { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 1000000, maxOutput: 8192 },
      ],
    });
    registry.register(gemini);

    const modelsOn = await registry.allModels('on');
    expect(modelsOn).toHaveLength(2);
    expect(modelsOn[0].id).toBe('gemini-web/gemini-3-flash');
    expect(modelsOn[1].id).toBe('gemini-web/gemini-2.5-pro');
  });

  it('resolves top-level provider aliases to provider default model', async () => {
    const registry = new ProviderRegistry();
    const gemini = new MockProvider('gemini-web', {
      authenticated: true,
      models: [{ id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1000000, maxOutput: 8192 }],
    });
    registry.register(gemini);

    const resolved = await registry.resolve('gemini');
    expect(resolved.provider).toBe(gemini);
    expect(resolved.model).toBe('gemini-3-flash');

    const resolvedGoogle = await registry.resolve('google');
    expect(resolvedGoogle.provider).toBe(gemini);
    expect(resolvedGoogle.model).toBe('gemini-3-flash');
  });

  it('allows registering and persisting dynamically discovered models', () => {
    const service = new ModelDiscoveryService();
    service.registerDiscoveredModels('gemini-web', [
      { id: 'gemini-3.5-ultra', name: 'Gemini 3.5 Ultra', contextWindow: 2000000, maxOutput: 8192 },
    ]);

    const models = service.getModelsForProvider('gemini-web');
    const ultra = models.find(m => m.id === 'gemini-3.5-ultra');
    expect(ultra).toBeDefined();
    expect(ultra?.name).toBe('Gemini 3.5 Ultra');
  });
});
