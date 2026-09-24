#!/usr/bin/env python3
"""
test_chat.py — Test client for web-model-bridge OpenAI-compatible API
Sends chat completion requests to http://127.0.0.1:3457/v1 (or 3456)
Usage:
    python test_chat.py
    python test_chat.py --model gemini-web/gemini-3-flash
    python test_chat.py --model gemini-web/gemini-2.5-pro --prompt "Explain black holes"
    python test_chat.py --list-models
    python test_chat.py --no-stream
"""

import sys
import json
import argparse

# Force UTF-8 on Windows console if supported
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
try:
    import requests
except ImportError:
    requests = None
    import urllib.request
    import urllib.error

DEFAULT_URL = "http://127.0.0.1:3457/v1"
FALLBACK_URL = "http://127.0.0.1:3456/v1"
DEFAULT_MODEL = "gemini-web/gemini-3-flash"
DEFAULT_KEY = "not-needed"


def probe_base_url(preferred_url):
    """Check if preferred URL is listening, otherwise try fallback."""
    urls_to_try = [preferred_url]
    if preferred_url == DEFAULT_URL:
        urls_to_try.append(FALLBACK_URL)
    elif preferred_url == FALLBACK_URL:
        urls_to_try.append(DEFAULT_URL)

    for base in urls_to_try:
        clean = base.rstrip('/')
        test_url = f"{clean}/models"
        try:
            if requests:
                res = requests.get(test_url, timeout=2)
                if res.status_code == 200:
                    return clean
            else:
                req = urllib.request.Request(test_url)
                with urllib.request.urlopen(req, timeout=2) as r:
                    if r.status == 200:
                        return clean
        except Exception:
            continue
    return preferred_url.rstrip('/')


def list_models(base_url, api_key):
    url = f"{base_url}/models"
    headers = {"Authorization": f"Bearer {api_key}"}
    print(f"\n[*] Querying models from: {url}")
    try:
        if requests:
            r = requests.get(url, headers=headers, timeout=5)
            r.raise_for_status()
            data = r.json()
        else:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode('utf-8'))

        models = data.get("data", [])
        print(f"[+] Successfully retrieved {len(models)} model(s):")
        for m in models:
            m_id = m.get("id", "unknown")
            print(f"    * {m_id}")
        return models
    except Exception as e:
        print(f"[-] Failed to list models: {e}")
        return []


def chat_stream(base_url, model, messages, api_key):
    url = f"{base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    payload = {
        "model": model,
        "messages": messages,
        "stream": True
    }

    print(f"\n[*] Sending streaming request to: {url}")
    print(f"[*] Model: {model}")
    print(f"[*] Prompt: \"{messages[-1]['content']}\"")
    print("-" * 50)
    print("Assistant: ", end="", flush=True)

    if not requests:
        print("\n(requests library not found, falling back to non-streaming)")
        return chat_non_stream(base_url, model, messages, api_key)

    try:
        with requests.post(url, headers=headers, json=payload, stream=True, timeout=60) as resp:
            if resp.status_code != 200:
                print(f"\n[✗] HTTP {resp.status_code}: {resp.text}")
                return

            full_reply = ""
            for line in resp.iter_lines(decode_unicode=True):
                if not line:
                    continue
                if line.startswith("data:"):
                    data_str = line[5:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                        delta = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if delta:
                            print(delta, end="", flush=True)
                            full_reply += delta
                    except json.JSONDecodeError:
                        continue

            print("\n" + "-" * 50)
            print(f"[+] Stream completed ({len(full_reply)} characters received).")

    except requests.exceptions.ConnectionError:
        print(f"\n[-] Could not connect to {url}.")
        print("    Please ensure web-model-bridge is running (run 'npm start').")
    except Exception as e:
        print(f"\n[-] Error during stream: {e}")


def chat_non_stream(base_url, model, messages, api_key):
    url = f"{base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}"
    }
    payload = {
        "model": model,
        "messages": messages,
        "stream": False
    }

    print(f"\n[*] Sending non-streaming request to: {url}")
    print(f"[*] Model: {model}")
    print(f"[*] Prompt: \"{messages[-1]['content']}\"")
    print("-" * 50)

    try:
        if requests:
            resp = requests.post(url, headers=headers, json=payload, timeout=60)
            if resp.status_code != 200:
                print(f"[-] HTTP {resp.status_code}: {resp.text}")
                return
            data = resp.json()
        else:
            req_data = json.dumps(payload).encode('utf-8')
            req = urllib.request.Request(url, data=req_data, headers=headers, method='POST')
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode('utf-8'))

        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        print(f"Assistant: {content}")
        print("-" * 50)
        print(f"[+] Non-stream completed (ID: {data.get('id', 'N/A')}).")
    except Exception as e:
        print(f"[-] Error: {e}")


def main():
    parser = argparse.ArgumentParser(description="Test chat client for web-model-bridge")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"API Base URL (default: {DEFAULT_URL})")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--key", default=DEFAULT_KEY, help=f"API Key / Bearer token (default: {DEFAULT_KEY})")
    parser.add_argument("--prompt", default="Hello! Please introduce yourself in 2 concise sentences.", help="Prompt text")
    parser.add_argument("--system", default="", help="Optional system prompt")
    parser.add_argument("--no-stream", action="store_true", help="Disable streaming response")
    parser.add_argument("--list-models", action="store_true", help="List available models and exit")
    parser.add_argument("--no-auto-probe", action="store_true", help="Don't auto-probe between port 3457 and 3456")

    args = parser.parse_args()

    base_url = args.url
    if not args.no_auto_probe:
        probed = probe_base_url(args.url)
        if probed != args.url.rstrip('/'):
            print(f"[*] Port auto-detected: switching from {args.url} to {probed}")
        base_url = probed
    else:
        base_url = base_url.rstrip('/')

    print(f"==================================================")
    print(f"[WEB-MODEL-BRIDGE] Test Client")
    print(f"Target API: {base_url}")
    print(f"==================================================")

    if args.list_models:
        list_models(base_url, args.key)
        return

    messages = []
    if args.system:
        messages.append({"role": "system", "content": args.system})
    messages.append({"role": "user", "content": args.prompt})

    if args.no_stream:
        chat_non_stream(base_url, args.model, messages, args.key)
    else:
        chat_stream(base_url, args.model, messages, args.key)


if __name__ == "__main__":
    main()
