import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { ProviderRegistry } from '../core/registry.js';
import {
  formatStreamChunk,
  formatDoneChunk,
  formatNonStreamResponse,
  formatModelsResponse,
} from '../core/openai-formatter.js';
import { InvalidBodyError, AuthRequiredError, errorToHttpResponse } from '../core/errors.js';
import type { Message } from '../core/provider.js';
import type { StreamEvent } from '../core/stream.js';
import { processPromptAndFiles, type FileAttachment } from '../core/file-handler.js';

export function openaiRoutes(registry: ProviderRegistry): Hono {
  const app = new Hono();

  // Model Option configuration endpoints
  app.get('/v1/config/model-option', (c) => {
    return c.json({ modelOption: registry.discoveryService.getModelOption() });
  });

  app.post('/v1/config/model-option', async (c) => {
    try {
      const body = await c.req.json();
      if (body.modelOption === 'on' || body.modelOption === 'off') {
        registry.discoveryService.setModelOption(body.modelOption);
        return c.json({ status: 'ok', modelOption: registry.discoveryService.getModelOption() });
      }
      return c.json({ error: 'Invalid modelOption value. Must be "on" or "off"' }, 400);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  // Dynamic Model Discovery endpoint
  app.post('/v1/models/discover', async (c) => {
    const discovered = registry.discoveryService.getAllDetailedModels();
    return c.json({
      status: 'ok',
      count: discovered.length,
      models: formatModelsResponse(discovered).data,
    });
  });

  app.post('/v1/chat/completions', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      const res = errorToHttpResponse(new InvalidBodyError('invalid JSON'));
      return c.json(res.body, res.status as any);
    }

    if (!body.model || typeof body.model !== 'string') {
      const res = errorToHttpResponse(new InvalidBodyError('missing model field'));
      return c.json(res.body, res.status as any);
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      const res = errorToHttpResponse(new InvalidBodyError('missing messages field'));
      return c.json(res.body, res.status as any);
    }

    let resolved;
    try {
      resolved = await registry.resolve(body.model);
    } catch (err) {
      const res = errorToHttpResponse(err as Error);
      return c.json(res.body, res.status as any);
    }

    const { provider, model } = resolved;

    if (!(await provider.isAuthenticated())) {
      const res = errorToHttpResponse(new AuthRequiredError(provider.info.id));
      return c.json(res.body, res.status as any);
    }

    const runId = `wmb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const isStream = body.stream === true;

    // Extract any file attachments from top-level body or message blocks
    const attachedFiles: FileAttachment[] = [];
    if (Array.isArray(body.files)) {
      for (const f of body.files) {
        if (f && (f.data || f.path)) {
          attachedFiles.push({
            name: f.name || `file_${Date.now()}`,
            type: f.type || 'application/octet-stream',
            data: f.data,
            path: f.path,
          });
        }
      }
    }

    // Inspect messages for multipart or inline file content
    const rawMessages: Message[] = body.messages.map((m: any) => {
      if (Array.isArray(m.content)) {
        let textAccum = '';
        for (const part of m.content) {
          if (part.type === 'text') {
            textAccum += part.text || '';
          } else if (part.type === 'image_url' && part.image_url?.url) {
            attachedFiles.push({
              name: `image_${Date.now()}.png`,
              type: 'image/png',
              data: part.image_url.url,
            });
          } else if (part.type === 'file' && part.file) {
            attachedFiles.push({
              name: part.file.name || `file_${Date.now()}`,
              type: part.file.type || 'application/octet-stream',
              data: part.file.data,
              path: part.file.path,
            });
          }
        }
        return { ...m, content: textAccum };
      }
      return m;
    });

    // 25k-Word Prompt Auto-File Conversion
    // Find the latest user message
    const lastUserIndex = rawMessages.map(m => m.role).lastIndexOf('user');
    let wasConverted = false;
    let finalFiles = attachedFiles;

    if (lastUserIndex !== -1) {
      const userContent = String(rawMessages[lastUserIndex].content || '');
      const processed = processPromptAndFiles(userContent, attachedFiles, 25000);
      rawMessages[lastUserIndex].content = processed.promptText;
      finalFiles = processed.files;
      wasConverted = processed.wasAutoConvertedToFile;
    }

    const messages = rawMessages;

    const typingDelayMs = typeof body.typing_delay_ms === 'number'
      ? body.typing_delay_ms
      : (typeof body.typingDelayMs === 'number' ? body.typingDelayMs : undefined);

    if (isStream) {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return stream(c, async (s) => {
        let isFirst = true;
        let returnedFiles: any[] = [];
        try {
          for await (const event of provider.chat({ model, messages, stream: true, files: finalFiles, typingDelayMs })) {
            if ((event as any).type === 'files' && Array.isArray((event as any).files)) {
              returnedFiles.push(...(event as any).files);
              const fileChunk = {
                id: runId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [{ index: 0, delta: {}, finish_reason: null }],
                files: (event as any).files,
              };
              await s.write(`data: ${JSON.stringify(fileChunk)}\n\n`);
              continue;
            }

            const chunk = formatStreamChunk(runId, body.model, event, isFirst);
            if ((event as any).scene) {
              (chunk as any).error_scene = (event as any).scene;
            }
            await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
            isFirst = false;
          }
          await s.write(`data: ${formatDoneChunk()}\n\n`);
        } catch (err) {
          const errEvent: StreamEvent = {
            type: 'error',
            message: (err as Error).message,
          };
          const chunk = formatStreamChunk(runId, body.model, errEvent, false);
          await s.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await s.write(`data: ${formatDoneChunk()}\n\n`);
        }
      });
    }

    // Non-streaming
    let fullContent = '';
    let lastError: string | null = null;
    let errorScene: any = null;
    const returnedFiles: any[] = [];

    for await (const event of provider.chat({ model, messages, stream: false, files: finalFiles, typingDelayMs })) {
      if (event.type === 'text_delta') {
        fullContent += event.delta;
      } else if (event.type === 'error') {
        lastError = event.message;
        errorScene = (event as any).scene || null;
      } else if ((event as any).type === 'files' && Array.isArray((event as any).files)) {
        returnedFiles.push(...(event as any).files);
      }
    }

    if (fullContent.length === 0 && lastError) {
      return c.json({
        error: {
          message: lastError,
          type: 'provider_error',
          code: 'provider_error',
          scene: errorScene,
        },
      }, 502 as any);
    }

    const resObj = formatNonStreamResponse(runId, body.model, fullContent);
    if (returnedFiles.length > 0) {
      (resObj as any).files = returnedFiles;
    }
    if (wasConverted) {
      (resObj as any).auto_converted_file = true;
    }

    return c.json(resObj);
  });

  app.get('/v1/models', async (c) => {
    const modeParam = c.req.query('mode') || c.req.query('model_option');
    const overrideMode = (modeParam === 'on' || modeParam === 'models') ? 'on'
      : (modeParam === 'off' || modeParam === 'providers') ? 'off'
      : undefined;

    const models = await registry.allModels(overrideMode);
    return c.json(formatModelsResponse(models));
  });

  return app;
}
