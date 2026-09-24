#!/usr/bin/env node
/**
 * test_chat.mjs — Node.js test client for web-model-bridge OpenAI-compatible API
 *
 * Usage:
 *   node test_chat.mjs
 *   node test_chat.mjs --url http://127.0.0.1:3457/v1
 *   node test_chat.mjs --model gemini --prompt "What is speed of light?"
 *   node test_chat.mjs --model chatgpt --prompt "Hello from ChatGPT"
 *   node test_chat.mjs --list-models --mode providers
 *   node test_chat.mjs --list-models --mode models
 *   node test_chat.mjs --discover
 *   node test_chat.mjs --file ./image.png --prompt "What is in this file?"
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:3457/v1';
const FALLBACK_URL = 'http://127.0.0.1:3456/v1';
const DEFAULT_MODEL = 'gemini';
const DEFAULT_KEY = 'not-needed';

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(flag, defaultValue) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return defaultValue;
}
const hasFlag = (flag) => args.includes(flag);

const preferredUrl = getArg('--url', DEFAULT_URL).replace(/\/+$/, '');
const model = getArg('--model', DEFAULT_MODEL);
const apiKey = getArg('--key', DEFAULT_KEY);
const prompt = getArg('--prompt', 'Hello! Tell me 2 interesting space facts.');
const mode = getArg('--mode', '');
const filePath = getArg('--file', '');
const isListModels = hasFlag('--list-models');
const isDiscover = hasFlag('--discover');
const isNonStream = hasFlag('--no-stream');

async function probeBaseUrl(targetUrl) {
  const candidates = [targetUrl];
  if (targetUrl === DEFAULT_URL) candidates.push(FALLBACK_URL);
  else if (targetUrl === FALLBACK_URL) candidates.push(DEFAULT_URL);

  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate}/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return candidate;
    } catch {
      // try next
    }
  }
  return targetUrl;
}

async function listModels(baseUrl) {
  const url = mode ? `${baseUrl}/models?mode=${mode}` : `${baseUrl}/models`;
  console.log(`\n[*] Querying models from: ${url}`);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    console.log(`[+] Retrieved ${data.data?.length || 0} model(s):`);
    for (const m of data.data || []) {
      console.log(`    * ${m.id} ${m.name ? `(${m.name})` : ''}`);
    }
  } catch (err) {
    console.error(`[-] Failed to fetch models: ${err.message}`);
  }
}

async function discoverModels(baseUrl) {
  console.log(`\n[*] Triggering model discovery at: ${baseUrl}/models/discover`);
  try {
    const res = await fetch(`${baseUrl}/models/discover`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const data = await res.json();
    console.log(`[+] Discovered ${data.count || 0} active models:`);
    for (const m of data.models || []) {
      console.log(`    * ${m.id} - ${m.name}`);
    }
  } catch (err) {
    console.error(`[-] Discovery failed: ${err.message}`);
  }
}

async function chat(baseUrl) {
  const endpoint = `${baseUrl}/chat/completions`;
  const stream = !isNonStream;

  console.log(`\n[*] Target Endpoint: ${endpoint}`);
  console.log(`[*] Model: ${model}`);
  console.log(`[*] Stream: ${stream}`);
  console.log(`[*] Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`);
  
  const files = [];
  if (filePath) {
    if (existsSync(filePath)) {
      const buffer = readFileSync(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      const mime = ext === 'png' ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'pdf' ? 'application/pdf'
        : ext === 'mp4' ? 'video/mp4'
        : ext === 'mp3' ? 'audio/mp3'
        : 'text/plain';

      files.push({
        name: basename(filePath),
        type: mime,
        data: `data:${mime};base64,${buffer.toString('base64')}`,
      });
      console.log(`[*] Attached file: ${basename(filePath)} (${buffer.length} bytes)`);
    } else {
      console.warn(`[-] File not found: ${filePath}`);
    }
  }

  console.log('-'.repeat(50));
  process.stdout.write('Assistant: ');

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        files,
        stream,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log(`\n[-] HTTP ${res.status}: ${text}`);
      return;
    }

    if (!stream) {
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '(No content)';
      console.log(content);
      if (data.files && data.files.length > 0) {
        console.log(`[+] Generated files:`, data.files);
      }
      console.log('-'.repeat(50));
      console.log(`[+] Response ID: ${data.id}`);
      return;
    }

    // Stream SSE chunks
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const chunk = JSON.parse(dataStr);
          if (chunk.files) {
            console.log(`\n[+] Received files:`, chunk.files);
          }
          if (chunk.error_scene) {
            console.log(`\n[!] Error Scene captured:`, chunk.error_scene.url);
          }
          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (delta) {
            process.stdout.write(delta);
            accumulated += delta;
          }
        } catch {
          // ignore
        }
      }
    }

    console.log('\n' + '-'.repeat(50));
    console.log(`[+] Stream finished (${accumulated.length} chars).`);
  } catch (err) {
    console.error(`\n[-] Connection / Request failed: ${err.message}`);
    console.log(`    Make sure web-model-bridge is running on ${baseUrl}`);
  }
}

async function main() {
  const baseUrl = await probeBaseUrl(preferredUrl);
  if (baseUrl !== preferredUrl) {
    console.log(`[*] Auto-switched port: ${preferredUrl} -> ${baseUrl}`);
  }

  console.log('='.repeat(50));
  console.log(`[WEB-MODEL-BRIDGE] Hackathon Test Client`);
  console.log(`API Base: ${baseUrl}`);
  console.log('='.repeat(50));

  if (isDiscover) {
    await discoverModels(baseUrl);
  } else if (isListModels) {
    await listModels(baseUrl);
  } else {
    await chat(baseUrl);
  }
}

main();
