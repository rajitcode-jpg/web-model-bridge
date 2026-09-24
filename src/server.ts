import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { openaiRoutes } from './routes/openai-compat.js';
import { anthropicRoutes } from './routes/anthropic-compat.js';
import { managementRoutes, type ManagementDeps } from './routes/management.js';
import { ProviderRegistry } from './core/registry.js';
import { AuthStore } from './auth/store.js';
import type { BrowserStatus, LoginState } from './browser/manager.js';
import { InvalidTokenError, errorToHttpResponse } from './core/errors.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findDashboardFile(filename: string): string | null {
  const candidates = [
    join(__dirname, 'dashboard', filename),
    join(__dirname, '..', 'src', 'dashboard', filename),
    join(process.cwd(), 'src', 'dashboard', filename),
    join(process.cwd(), filename),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p, 'utf-8');
    } catch {
      // try next
    }
  }
  return null;
}

export interface AppOptions {
  registry: ProviderRegistry;
  authStore: AuthStore;
  authToken: string | null;
  onLogin?: (providerId: string) => Promise<{ status: string; message: string; loginUrl?: string }>;
  getBrowserStatus?: () => BrowserStatus;
  getLoginState?: (providerId?: string) => LoginState;
  scanActiveSessions?: () => Promise<string[]>;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Enable CORS for web UI and third-party tools
  app.use('*', cors());

  // Optional Auth middleware (only if explicitly set and not 'not-needed')
  if (opts.authToken && opts.authToken !== 'not-needed') {
    const checkToken = async (c: any, next: any) => {
      const authHeader = c.req.header('Authorization');
      const xApiKey = c.req.header('x-api-key');
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : xApiKey ?? null;
      if (token !== opts.authToken) {
        const res = errorToHttpResponse(new InvalidTokenError());
        return c.json(res.body, res.status as any);
      }
      await next();
    };
    app.use('/v1/*', checkToken);
    app.use('/webmodel/*', checkToken);
  }

  // Dashboard
  app.get('/', (c) => {
    const html = findDashboardFile('index.html') || findDashboardFile('chat.html');
    if (html) return c.html(html);
    return c.text('Dashboard loaded', 200);
  });

  // Chat UI
  app.get('/chat', (c) => {
    const html = findDashboardFile('chat.html');
    if (html) return c.html(html);
    return c.text('Chat UI loaded', 200);
  });

  app.get('/dashboard/:file', (c) => {
    const file = c.req.param('file');
    const ext = file.split('.').pop();
    const contentType = ext === 'js' ? 'application/javascript'
      : ext === 'css' ? 'text/css'
      : 'text/plain';

    const content = findDashboardFile(file);
    if (content !== null) {
      return c.text(content, 200, { 'Content-Type': contentType });
    }
    return c.text('Not found', 404);
  });

  // Mount API routes
  app.route('/', openaiRoutes(opts.registry));
  app.route('/', anthropicRoutes(opts.registry));

  const mgmtDeps: ManagementDeps = {
    registry: opts.registry,
    authStore: opts.authStore,
    onLogin: opts.onLogin,
    getLoginState: opts.getLoginState,
    getBrowserStatus: opts.getBrowserStatus,
    scanActiveSessions: opts.scanActiveSessions,
    startTime: Date.now(),
  };
  app.route('/', managementRoutes(mgmtDeps));

  return app;
}
