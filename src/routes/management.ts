import { Hono } from 'hono';
import { ProviderRegistry } from '../core/registry.js';
import { AuthStore } from '../auth/store.js';
import type { BrowserStatus, LoginState } from '../browser/manager.js';
import type { MetricsCollector } from '../core/metrics.js';

export interface ManagementDeps {
  registry: ProviderRegistry;
  authStore: AuthStore;
  onLogin?: (providerId: string) => Promise<{ status: string; message: string; loginUrl?: string }>;
  getLoginState?: (providerId?: string) => LoginState;
  getBrowserStatus?: () => BrowserStatus;
  scanActiveSessions?: () => Promise<string[]>;
  startTime?: number;
  metrics?: MetricsCollector;
}

export function managementRoutes(deps: ManagementDeps): Hono {
  const { registry, authStore, onLogin } = deps;
  const routeStartTime = deps.startTime ?? Date.now();
  const app = new Hono();

  app.get('/webmodel/providers', async (c) => {
    if (deps.scanActiveSessions) {
      try {
        const activeIds = await deps.scanActiveSessions();
        for (const id of activeIds) {
          if (authStore.getStatus(id).status !== 'active') {
            authStore.setStatus(id, 'active');
          }
        }
      } catch {
        // Non-blocking scan
      }
    }
    const statuses = await registry.providerStatus();
    return c.json({ providers: statuses });
  });

  app.post('/webmodel/auth/login', async (c) => {
    let body: { providerId: string };
    try {
      body = await c.req.json<{ providerId: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const provider = registry.getProvider(body.providerId);
    if (!provider) {
      return c.json({ error: 'Unknown provider', message: `Provider "${body.providerId}" not found.` }, 404);
    }

    if (!onLogin) {
      return c.json({
        error: 'Browser not available',
        message: 'Browser manager is not configured. Restart the server.',
      }, 503);
    }

    try {
      // This returns immediately — login happens in background
      const result = await onLogin(body.providerId);
      return c.json({
        ...result,
        loginUrl: result.loginUrl || provider.info.loginUrl,
      });
    } catch (err) {
      return c.json({
        status: 'error',
        message: (err as Error).message,
      }, 500);
    }
  });

  // Poll login progress for a specific provider or general
  app.get('/webmodel/auth/login-status', async (c) => {
    const providerId = c.req.query('providerId');
    if (!deps.getLoginState) {
      return c.json({ providerId: null, status: 'idle', message: '' });
    }
    return c.json(deps.getLoginState(providerId));
  });

  app.post('/webmodel/auth/check', async (c) => {
    let body: { providerId: string };
    try {
      body = await c.req.json<{ providerId: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const status = authStore.getStatus(body.providerId);
    return c.json(status);
  });

  app.post('/webmodel/auth/logout', async (c) => {
    let body: { providerId: string };
    try {
      body = await c.req.json<{ providerId: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    authStore.clearStatus(body.providerId);
    return c.json({ status: 'logged_out', providerId: body.providerId });
  });

  app.post('/webmodel/auth/clear-all', async (c) => {
    const all = authStore.getAllStatuses();
    for (const s of all) {
      authStore.clearStatus(s.providerId);
    }
    return c.json({ status: 'all_cleared', count: all.length });
  });

  app.get('/webmodel/health', async (c) => {
    const statuses = await registry.providerStatus();
    const browserStatus = deps.getBrowserStatus ? deps.getBrowserStatus() : 'stopped';
    return c.json({
      status: 'healthy',
      uptime: Math.floor((Date.now() - routeStartTime) / 1000),
      browser: { status: browserStatus },
      providers: Object.fromEntries(
        statuses.map(s => [s.id, { authenticated: s.authenticated, models: s.modelCount }])
      ),
    });
  });

  app.get('/webmodel/metrics', async (c) => {
    if (!deps.metrics) return c.json({ error: 'Metrics not available' }, 503);
    return c.json(deps.metrics.getSummary());
  });

  app.get('/webmodel/logs', async (c) => {
    if (!deps.metrics) return c.json({ error: 'Metrics not available' }, 503);
    const count = parseInt(c.req.query('count') ?? '50', 10);
    return c.json({ logs: deps.metrics.getRecent(count) });
  });

  return app;
}
