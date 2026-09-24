var origin = window.location.origin;
document.getElementById('openai-url').textContent = origin + '/v1';
document.getElementById('anthropic-url').textContent = origin;

// Toast notification
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function () {
    t.classList.remove('show');
  }, 2000);
}

// Copy URL — uses data-target attribute instead of inline onclick
function copyText(targetId) {
  var text = document.getElementById(targetId).textContent;
  navigator.clipboard.writeText(text).then(function () {
    showToast('Copied to clipboard!');
  });
}

// Bind copy buttons via data-target (no inline handlers)
document.querySelectorAll('.btn-copy[data-target]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    copyText(btn.getAttribute('data-target'));
  });
});

// Load providers list
async function loadProviders() {
  try {
    var res = await fetch('/webmodel/providers');
    var data = await res.json();
    var list = document.getElementById('provider-list');
    var countEl = document.getElementById('provider-count');

    if (!data.providers || data.providers.length === 0) {
      list.textContent = '';
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty';
      emptyDiv.textContent = 'No providers configured.';
      list.appendChild(emptyDiv);
      countEl.textContent = '0 / 0';
      return;
    }

    var authCount = data.providers.filter(function (p) {
      return p.authenticated;
    }).length;
    countEl.textContent = authCount + ' / ' + data.providers.length + ' active';

    list.textContent = '';

    data.providers.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'provider-row';

      var left = document.createElement('div');
      left.className = 'provider-left';

      var dot = document.createElement('div');
      dot.className =
        'status-indicator ' + (p.authenticated ? 'active' : 'inactive');
      left.appendChild(dot);

      var nameEl = document.createElement('span');
      nameEl.className = 'provider-name';
      nameEl.textContent = p.name;
      left.appendChild(nameEl);

      var idEl = document.createElement('span');
      idEl.className = 'provider-id';
      idEl.textContent = p.id;
      left.appendChild(idEl);

      row.appendChild(left);

      var right = document.createElement('div');
      right.className = 'provider-right';

      if (p.authenticated) {
        var badge = document.createElement('span');
        badge.className = 'model-badge';
        badge.textContent = p.modelCount + ' models';
        right.appendChild(badge);
      } else {
        var btn = document.createElement('button');
        btn.className = 'btn-login';
        btn.textContent = 'Login';
        btn.addEventListener('click', function () {
          loginProvider(p.id);
        });
        right.appendChild(btn);
      }

      row.appendChild(right);
      list.appendChild(row);
    });
  } catch (err) {
    var list = document.getElementById('provider-list');
    list.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Failed to load: ' + err.message;
    list.appendChild(errDiv);
  }
}

var PROVIDER_LOGIN_URLS = {
  'chatgpt-web': 'https://chatgpt.com/auth/login',
  'claude-web': 'https://claude.ai/login',
  'deepseek-web': 'https://chat.deepseek.com/sign_in',
  'gemini-web': 'https://gemini.google.com',
  'grok-web': 'https://grok.com',
  'kimi-web': 'https://www.kimi.ai',
  'qwen-web': 'https://chat.qwen.ai/auth',
  'glm-web': 'https://chat.z.ai',
  'perplexity-web': 'https://www.perplexity.ai',
};

// Login flow
async function loginProvider(providerId) {
  try {
    showToast('Opening ' + providerId + ' in the dedicated Web Model Bridge Chrome window...');

    var res = await fetch('/webmodel/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: providerId }),
    });
    var data = await res.json();
    if (data.status === 'login_started') {
      showToast(data.message || 'Login tab opened in dedicated Chrome. Please log in there.');
      pollLoginStatus(providerId);
    } else if (data.status === 'error' || data.error) {
      showToast(data.message || data.error || 'Login failed');
    }
  } catch (err) {
    showToast('Login failed: ' + err.message);
  }
}

// Poll login status endpoint for real-time feedback
function pollLoginStatus(providerId) {
  var interval = setInterval(async function () {
    try {
      // Check login-status for detailed progress
      var statusRes = await fetch('/webmodel/auth/login-status?providerId=' + encodeURIComponent(providerId));
      var statusData = await statusRes.json();
      if (statusData.status === 'waiting_for_user') {
        showToast('Waiting for you to log in at the Chrome window...');
      } else if (statusData.status === 'success') {
        clearInterval(interval);
        showToast(providerId + ' login completed!');
        loadProviders();
        loadHealth();
        return;
      } else if (statusData.status === 'failed') {
        clearInterval(interval);
        showToast('Login failed: ' + statusData.message);
        return;
      }

      // Also check provider status as backup
      var res = await fetch('/webmodel/providers');
      var data = await res.json();
      var provider = data.providers.find(function (p) {
        return p.id === providerId;
      });
      if (provider && provider.authenticated) {
        clearInterval(interval);
        showToast(providerId + ' authenticated!');
        loadProviders();
        loadHealth();
      }
    } catch (e) {
      /* retry */
    }
  }, 2000);
  setTimeout(function () {
    clearInterval(interval);
  }, 120000);
}

// Load system health stats
async function loadHealth() {
  try {
    var res = await fetch('/webmodel/health');
    var data = await res.json();
    var el = document.getElementById('health-info');

    var seconds = data.uptime || 0;
    var uptime =
      seconds < 60
        ? seconds + 's'
        : seconds < 3600
          ? Math.floor(seconds / 60) + 'm'
          : Math.floor(seconds / 3600) +
            'h ' +
            Math.floor((seconds % 3600) / 60) +
            'm';

    var browserStatus = data.browser ? data.browser.status : 'unknown';

    el.textContent = '';

    var items = [
      {
        label: 'Status',
        value: data.status || 'unknown',
        cls: data.status === 'healthy' ? 'green' : '',
      },
      { label: 'Uptime', value: uptime, cls: '' },
      {
        label: 'Browser',
        value: browserStatus,
        cls: browserStatus === 'running' ? 'green' : '',
      },
    ];

    items.forEach(function (item) {
      var div = document.createElement('div');
      div.className = 'stat-item';

      var label = document.createElement('span');
      label.className = 'stat-label';
      label.textContent = item.label;
      div.appendChild(label);

      var val = document.createElement('span');
      val.className = 'stat-value' + (item.cls ? ' ' + item.cls : '');
      val.textContent = item.value;
      div.appendChild(val);

      el.appendChild(div);
    });
  } catch (e) {
    var el = document.getElementById('health-info');
    el.textContent = '';
    var errDiv = document.createElement('div');
    errDiv.className = 'error';
    errDiv.textContent = 'Unable to reach server';
    el.appendChild(errDiv);
  }
}

// ── Code Implementation Snippet Generator ──
var activeCodeTab = 'curl-openai';

var SNIPPET_MODELS = {
  gemini: { canonical: 'gemini-web/gemini-3-flash', name: 'Google Gemini 3 Flash' },
  chatgpt: { canonical: 'chatgpt-web/gpt-5.4-mini', name: 'ChatGPT 5.4 Mini' },
  claude: { canonical: 'claude-web/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  deepseek: { canonical: 'deepseek-web/deepseek-v4', name: 'DeepSeek V4' },
  qwen: { canonical: 'qwen-web/qwen-3.5-plus', name: 'Qwen 3.5 Plus' },
  grok: { canonical: 'grok-web/grok-3', name: 'xAI Grok 3' },
  perplexity: { canonical: 'perplexity-web/sonar-pro', name: 'Perplexity Sonar Pro' },
  kimi: { canonical: 'kimi-web/kimi-k2.5', name: 'Moonshot Kimi K2.5' },
  glm: { canonical: 'glm-web/glm-5', name: 'Zhipu GLM 5' },
};

function generateSnippet(tab, modelKey) {
  var baseUrl = window.location.origin;
  var modelInfo = SNIPPET_MODELS[modelKey] || { canonical: modelKey, name: modelKey };
  var alias = modelKey;
  var canonical = modelInfo.canonical;
  var name = modelInfo.name;

  switch (tab) {
    case 'curl-openai':
      return {
        lang: 'BASH / CURL (OPENAI FORMAT)',
        code:
'curl ' + baseUrl + '/v1/chat/completions \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -d \'{\n' +
'    "model": "' + alias + '",\n' +
'    "messages": [\n' +
'      {"role": "user", "content": "Explain quantum computing in two concise sentences."}\n' +
'    ],\n' +
'    "stream": true\n' +
'  }\''
      };

    case 'curl-anthropic':
      return {
        lang: 'BASH / CURL (ANTHROPIC FORMAT)',
        code:
'curl ' + baseUrl + '/v1/messages \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -H "x-api-key: not-needed" \\\n' +
'  -H "anthropic-version: 2023-06-01" \\\n' +
'  -d \'{\n' +
'    "model": "' + (canonical.startsWith('claude') ? canonical : 'claude-web/claude-sonnet-4-6') + '",\n' +
'    "max_tokens": 1024,\n' +
'    "messages": [\n' +
'      {"role": "user", "content": "Explain quantum computing in two concise sentences."}\n' +
'    ],\n' +
'    "stream": true\n' +
'  }\''
      };

    case 'python':
      return {
        lang: 'PYTHON (OPENAI SDK)',
        code:
'from openai import OpenAI\n\n' +
'# Connect to local web-model-bridge daemon\n' +
'client = OpenAI(\n' +
'    base_url="' + baseUrl + '/v1",\n' +
'    api_key="not-needed"\n' +
')\n\n' +
'# Stream responses from ' + name + '\n' +
'response = client.chat.completions.create(\n' +
'    model="' + alias + '",\n' +
'    messages=[\n' +
'        {"role": "user", "content": "Explain quantum computing in two concise sentences."}\n' +
'    ],\n' +
'    stream=True\n' +
')\n\n' +
'for chunk in response:\n' +
'    delta = chunk.choices[0].delta.content or ""\n' +
'    print(delta, end="", flush=True)\n' +
'print()'
      };

    case 'nodejs':
      return {
        lang: 'JAVASCRIPT / NODE.JS (OPENAI SDK)',
        code:
'import OpenAI from \'openai\';\n\n' +
'// Connect to local web-model-bridge daemon\n' +
'const client = new OpenAI({\n' +
'  baseURL: \'' + baseUrl + '/v1\',\n' +
'  apiKey: \'not-needed\',\n' +
'});\n\n' +
'async function main() {\n' +
'  const stream = await client.chat.completions.create({\n' +
'    model: \'' + alias + '\',\n' +
'    messages: [\n' +
'      { role: \'user\', content: \'Explain quantum computing in two concise sentences.\' }\n' +
'    ],\n' +
'    stream: true,\n' +
'  });\n\n' +
'  for await (const chunk of stream) {\n' +
'    process.stdout.write(chunk.choices[0]?.delta?.content || \'\');\n' +
'  }\n' +
'  console.log();\n' +
'}\n\n' +
'main();'
      };

    case 'claude-cli':
      return {
        lang: 'BASH / SHELL (CLAUDE CODE CLI)',
        code:
'# Configure Claude Code CLI to route through web-model-bridge\n' +
'export ANTHROPIC_BASE_URL="' + baseUrl + '"\n' +
'export ANTHROPIC_API_KEY="not-needed"\n\n' +
'# Launch Claude Code (Free Claude Sonnet 4.6 via your browser session!)\n' +
'claude'
      };

    case 'cursor':
      return {
        lang: 'JSON / CURSOR & WINDSURF SETTINGS',
        code:
'// In Cursor / Windsurf Settings -> Models -> Add Custom Model:\n' +
'{\n' +
'  "openai_base_url": "' + baseUrl + '/v1",\n' +
'  "openai_api_key": "not-needed",\n' +
'  "model": "' + alias + '"\n' +
'}'
      };

    case 'openclaw':
      return {
        lang: 'JSON / OPENCLAW & LIBRECHAT CONFIG',
        code:
'// Add to ~/.openclaw/openclaw.json or LibreChat configuration:\n' +
'{\n' +
'  "models": {\n' +
'    "providers": {\n' +
'      "webmodel": {\n' +
'        "baseUrl": "' + baseUrl + '/v1",\n' +
'        "apiKey": "not-needed",\n' +
'        "api": "openai-completions",\n' +
'        "models": [\n' +
'          { "id": "' + alias + '", "name": "' + name + ' (Free)" }\n' +
'        ]\n' +
'      }\n' +
'    }\n' +
'  }\n' +
'}'
      };

    default:
      return { lang: 'TEXT', code: '' };
  }
}

function updateSnippetDisplay() {
  var modelSelect = document.getElementById('snippet-model-select');
  var selectedModel = modelSelect ? modelSelect.value : 'deepseek';
  var snippet = generateSnippet(activeCodeTab, selectedModel);

  var codeEl = document.getElementById('code-snippet-display');
  var langEl = document.getElementById('code-lang-indicator');
  if (codeEl) codeEl.textContent = snippet.code;
  if (langEl) langEl.textContent = snippet.lang;
}

// Bind tabs
document.querySelectorAll('.code-tab').forEach(function (tabBtn) {
  tabBtn.addEventListener('click', function () {
    document.querySelectorAll('.code-tab').forEach(function (b) {
      b.classList.remove('active');
    });
    tabBtn.classList.add('active');
    activeCodeTab = tabBtn.getAttribute('data-tab');
    updateSnippetDisplay();
  });
});

// Bind model change
var snippetSelect = document.getElementById('snippet-model-select');
if (snippetSelect) {
  snippetSelect.addEventListener('change', updateSnippetDisplay);
}

// Bind snippet copy button
var copySnippetBtn = document.getElementById('btn-copy-snippet');
var copySnippetText = document.getElementById('btn-copy-snippet-text');
if (copySnippetBtn) {
  copySnippetBtn.addEventListener('click', function () {
    var codeEl = document.getElementById('code-snippet-display');
    if (!codeEl) return;
    navigator.clipboard.writeText(codeEl.textContent).then(function () {
      if (copySnippetText) copySnippetText.textContent = 'Copied!';
      showToast('API implementation code copied to clipboard!');
      setTimeout(function () {
        if (copySnippetText) copySnippetText.textContent = 'Copy Code';
      }, 2000);
    });
  });
}

// Initial load + auto-refresh every 10s
updateSnippetDisplay();
loadProviders();
loadHealth();
setInterval(function () {
  loadProviders();
  loadHealth();
}, 10000);
