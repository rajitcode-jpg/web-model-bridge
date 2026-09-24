# 🌉 web-model-bridge

**Universal Local AI Inference Bridge — Zero Token Costs, Zero API Keys**

Turn free web-based AI interfaces into standardized **OpenAI (`/v1/chat/completions`)** and **Anthropic (`/v1/messages`)** APIs. Compatible with Claude Code, Cursor, OpenClaw, Continue.dev, and any standard LLM application.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue.svg)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/Tests-Passing-brightgreen.svg)](#testing)

[Quick Start](#quick-start) · [Supported Providers](#supported-providers) · [Connecting AI Tools](#connecting-your-ai-tools) · [API Reference](#api-reference) · [Architecture](#architecture) · [Configuration](#configuration)

---

## What is this?

**web-model-bridge** is a local proxy daemon that bridges developer tools, IDE extensions, and automated workflows directly to the web interfaces of 9 leading AI providers.

```
Your AI Tool  ──►  web-model-bridge  ──►  Google Chrome (CDP)  ──►  Web AI Platforms
(Claude Code,      (http://127.0.0.1:3456) (Real Browser Session)    (claude.ai, chatgpt.com,
 Cursor, OpenClaw)                                                    deepseek.com, etc.)
```

Unlike reverse-engineered API parsers that frequently break due to Cloudflare anti-bot checks and rotating session tokens, **web-model-bridge automates a genuine Chrome browser instance**. It inherits authentic browser fingerprinting, TLS fingerprints, and pre-existing login cookies—delivering maximum reliability at zero financial cost.

---

## Why web-model-bridge?

| Feature | web-model-bridge | gpt4free | CLIProxyAPI | chat2api |
|---|---|---|---|---|
| **Approach** | Real browser engine automation (CDP) | Reverse-engineered endpoints | CLI OAuth wrapper | Token simulation |
| **Anti-Bot Resistance** | **Highest** (Genuine Chrome fingerprint) | Low (Fails on Cloudflare/WAF) | Medium | Low |
| **Cost** | **100% Free** (Uses free web sessions) | Free | Subscription required | Free |
| **Active Platforms** | **9 Major Providers (All in one)** | Unstable | 3–4 platforms | ChatGPT only |
| **Dual Protocols** | **OpenAI ChatML + Anthropic Messages** | OpenAI only | OpenAI + Anthropic | OpenAI only |
| **Thinking Suppression**| **Native** (Filters `<think>` artifacts) | ❌ Raw output only | ❌ None | ❌ None |
| **Interactive UI** | **Dashboard (`/`) + Playground (`/chat`)** | ❌ None | ❌ None | ❌ None |
| **Concurrency** | **Origin-Isolated Page Pooling** | ❌ Race conditions | Linear | Linear |

---

## Key Capabilities

* ⚡ **9 Flagship Providers Supported**: Claude, ChatGPT, DeepSeek, Google Gemini, xAI Grok, Perplexity, Moonshot Kimi, Qwen, and Zhipu GLM.
* 🔄 **Dual Industry Standards**: Seamlessly serves both OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`.
* 🧠 **Thinking & Scratchpad Suppression**: Automatically identifies and suppresses internal reasoning blocks (`<think>`, status wrappers), streaming only clean, finalized answers.
* 🛡️ **In-Page Error Intelligence**: Real-time DOM scanning immediately intercepts upstream rate limits, message quotas, or capacity overloads and returns clear error responses.
* ⌨️ **Typing Pacing & Anti-Block Pacing**: Automatically falls back to humanized typing delays (12ms) if complex modern web textboxes block instant clipboard pastes.
* 📋 **Interactive Code Generator in UI**: Built-in interactive code showcase in the Dashboard with 1-click copy for **cURL (OpenAI & Anthropic)**, **Python SDK**, **Node.js SDK**, **Claude Code CLI**, **Cursor/Windsurf**, and **OpenClaw/LibreChat**.
* 📎 **Multimodal File Attachments**: Supports code files, text, and images via standard API payloads.
* 🖥️ **Built-in Web Playground & Dashboard**: Test prompts directly in the browser at `http://localhost:3456/chat` (with quick-access `⚡ API Snippets` modal) or monitor session health at `http://localhost:3456`.
* 🔍 **Zero Friction Auto-Login Detection**: Scans pre-existing Chrome tabs on startup; if you are already logged into Gemini or Claude in Chrome, the bridge activates immediately.

---

## Quick Start

### 1. Start the Bridge

```bash
# Clone the repository
git clone https://github.com/rajitcode-jpg/web-model-bridge.git
cd web-model-bridge

# Install dependencies and start
npm install
npm start
```

On startup, web-model-bridge will:
1. Verify Google Chrome is available.
2. Connect to Chrome with remote debugging (or auto-launch a dedicated Chrome instance).
3. Auto-detect any providers where you are already signed in.
4. Open the **Command Center Dashboard** at `http://localhost:3456`.

### 2. Authenticate Providers

In the Dashboard ([http://localhost:3456](http://localhost:3456)), simply click **Login** next to any unauthenticated provider. A browser window opens for you to log in normally. The bridge automatically captures and preserves your active session.

### 3. Copy API Implementation Code Directly from the UI

In the Dashboard's **API Code Implementation** section (or clicking `⚡ API Snippets` inside the Chat Studio):
1. Select your target model (e.g. `deepseek`, `claude`, `gemini`, `chatgpt`).
2. Click your preferred tool/language tab (`cURL`, `Python`, `Node.js`, `Claude CLI`, `Cursor`, `OpenClaw`).
3. Click **Copy Code** for ready-to-run code tailored directly to your local instance!

---

## Supported Providers

web-model-bridge provides seamless, unified API access across 9 leading AI platforms using simple provider aliases (`claude`, `chatgpt`, `deepseek`, etc.):

| Provider | Alias / Model ID | Web Platform | Highlights |
|---|---|---|---|
| **Anthropic Claude** | `claude` | [claude.ai](https://claude.ai) | Sonnet & Haiku models, dual Anthropic `/v1/messages` protocol |
| **OpenAI ChatGPT** | `chatgpt` | [chatgpt.com](https://chatgpt.com) | GPT-4o, GPT-5 series with full session preservation |
| **DeepSeek** | `deepseek` | [chat.deepseek.com](https://chat.deepseek.com) | DeepSeek V4 & Reasoner with automatic `<think>` suppression |
| **Google Gemini** | `gemini` | [gemini.google.com](https://gemini.google.com) | Gemini 3 Flash & 2.5 Pro with large context window |
| **xAI Grok** | `grok` | [grok.com](https://grok.com) | Grok 3 with live reasoning & real-time search |
| **Perplexity** | `perplexity` | [perplexity.ai](https://perplexity.ai) | Sonar Pro citation-backed search completions |
| **Moonshot Kimi** | `kimi` | [kimi.ai](https://www.kimi.ai/) | Kimi K2.5 with long-document reasoning |
| **Alibaba Qwen** | `qwen` | [chat.qwen.ai](https://chat.qwen.ai) | Qwen 3.5 Plus & QwQ reasoning models |
| **Zhipu GLM** | `glm` | [chat.z.ai](https://chat.z.ai/) | GLM-5 series bilingual agentic intelligence |

---

## Connecting Your AI Tools

### Claude Code CLI
Point Claude Code directly to web-model-bridge's Anthropic endpoint:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
export ANTHROPIC_API_KEY="not-needed"
claude
```

### Cursor & Windsurf
1. Navigate to **Settings** → **Models** (or AI Provider).
2. Override **OpenAI Base URL**: `http://127.0.0.1:3456/v1`
3. Set **API Key**: `not-needed`
4. Add desired model ID (e.g. `gemini-web/gemini-3-flash` or `claude-web/claude-sonnet-4-6`).

### OpenClaw & LibreChat
Add to your model provider configuration:

```json
{
  "models": {
    "providers": {
      "webmodel": {
        "baseUrl": "http://127.0.0.1:3456/v1",
        "apiKey": "not-needed",
        "api": "openai-completions",
        "models": [
          { "id": "gemini", "name": "Gemini 3 Flash (Free)" },
          { "id": "deepseek", "name": "DeepSeek V4 (Free)" },
          { "id": "claude", "name": "Claude Sonnet 4.6 (Free)" }
        ]
      }
    }
  }
}
```

### Python OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3456/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="gemini",
    messages=[{"role": "user", "content": "Explain quantum computing in three sentences."}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.content or ""
    print(content, end="", flush=True)
```

---

## API Reference

### OpenAI Format (`/v1/chat/completions`)

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-web/deepseek-v4",
    "messages": [
      {"role": "system", "content": "You are a concise engineering assistant."},
      {"role": "user", "content": "What is the difference between a process and a thread?"}
    ],
    "stream": true
  }'
```

### Anthropic Format (`/v1/messages`)

```bash
curl http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: not-needed" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-web/claude-sonnet-4-6",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "Summarize the architectural advantages of microkernels."}
    ],
    "stream": true
  }'
```

### Model Discovery (`/v1/models`)

```bash
# Get high-level provider catalog
curl http://127.0.0.1:3456/v1/models?mode=providers

# Get granular model catalog
curl http://127.0.0.1:3456/v1/models?mode=models
```

---

## Architecture & Internals

```
┌────────────────────────────────────────────────────────┐
│              Standard AI Clients & Tools               │
│         (Claude Code, Cursor, OpenClaw, SDKs)          │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTP / Server-Sent Events
                           ▼
┌────────────────────────────────────────────────────────┐
│                   web-model-bridge                     │
│  ┌──────────────────────────────────────────────────┐  │
│  │ HTTP Layer (Hono): /v1/chat/completions, /v1/... │  │
│  └───────────────────────┬──────────────────────────┘  │
│  ┌───────────────────────▼──────────────────────────┐  │
│  │ Router & Registry (Aliases, Pacing & Retries)    │  │
│  └───────────────────────┬──────────────────────────┘  │
│  ┌───────────────────────▼──────────────────────────┐  │
│  │ Browser UI Driver (DOM Automation & Filtering)   │  │
│  └───────────────────────┬──────────────────────────┘  │
│  ┌───────────────────────▼──────────────────────────┐  │
│  │ Page Pool & Mutex (Origin Isolation & Pooling)   │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────────────────┬─────────────────────────────┘
                           │ Chrome DevTools Protocol (CDP)
                           ▼
┌────────────────────────────────────────────────────────┐
│            Google Chrome (Active User Session)         │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ │
│  │   Claude AI   │ │  ChatGPT Web  │ │  DeepSeek Web │ │
│  └───────────────┘ └───────────────┘ └───────────────┘ │
└────────────────────────────────────────────────────────┘
```

1. **Origin Partitioning**: Requests for different platforms execute in isolated browser tabs, preventing UI race conditions.
2. **Phase Tracking**: Responses are observed via dynamic MutationObservers and custom DOM evaluators that distinguish thinking traces from finalized answers.
3. **Graceful Degradation**: If clipboard pasting is rejected by an upstream editor, the system automatically falls back to simulated keypress typing with 12ms pacing.

---

## Configuration

### Command Line Options

```bash
web-model-bridge                         # Default startup on 127.0.0.1:3456
web-model-bridge -p 8080                 # Custom port
web-model-bridge --browser-mode launch   # Launch isolated browser instead of attach
web-model-bridge --host 0.0.0.0          # Enable LAN access (combine with --auth-token)
web-model-bridge --auth-token secret123  # Require Bearer token for API calls
web-model-bridge --no-open               # Disable auto-opening dashboard in browser
```

### Config File (`~/.webmodel/config.yml`)

```yaml
server:
  port: 3456
  host: 127.0.0.1
  authToken: null
  openDashboard: true

browser:
  mode: attach           # "attach" (CDP) or "launch" (persistent context)
  cdpUrl: http://127.0.0.1:9222
  idleShutdown: 300      # Recycle idle pages after 5 minutes

providers:
  enabled:
    - claude-web
    - chatgpt-web
    - deepseek-web
    - gemini-web
    - grok-web
    - perplexity-web
    - kimi-web
    - qwen-web
    - glm-web
```

---

## Testing

web-model-bridge includes a comprehensive automated test suite:

```bash
# Run complete test suite (unit + integration)
npm test

# Run unit tests only
npm run test:unit

# Run TypeScript type check
npm run typecheck

# Build bundle
npm run build

# Clear all saved session cookies and login states
npm run clear-auth
```

### Ready-to-Run Test Clients

Two interactive CLI clients are included for testing completions:

```bash
# Python client
python test_chat.py --model gemini --prompt "Explain quantum computing in one sentence"
python test_chat.py --list-models

# Node.js client
node test_chat.mjs --model deepseek --prompt "Write a fibonacci function in Rust"
node test_chat.mjs --list-models
```

---

## Security & Privacy Guarantee

* 🔒 **Zero Password Storage**: web-model-bridge never asks for, reads, or stores your passwords. You authenticate directly in the genuine provider web pages.
* 🏠 **Localhost First**: Binds strictly to `127.0.0.1` by default. No data or prompts ever leave your local machine except directly to the provider's official servers.
* 🚫 **No External Telemetry**: Zero analytics, zero cloud relay servers, and zero data harvesting.

---

## License

[MIT](LICENSE)