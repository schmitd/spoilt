#!/usr/bin/env python3
"""Run a browser-level fallback masking check in Chrome.

Chrome's headless extension injection is inconsistent across channels, so this
harness loads the fixture in Chrome and injects the real content script with a
minimal mocked extension API. That verifies the release-critical DOM behavior:
matching text becomes blacked-out spans and matching image metadata becomes a
black image shell when local AI/VLM is unavailable.
"""

import http.server
import json
import os
import pathlib
import shutil
import socket
import socketserver
import subprocess
import tempfile
import threading
import time
import urllib.request

import websocket

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = 8776
URL = f"http://127.0.0.1:{PORT}/tests/test-page.html"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def chrome_binary():
    candidates = [
        os.environ.get("CHROME"),
        os.environ.get("CHROME_BIN"),
        "google-chrome-stable",
        "google-chrome",
        "chrome",
        "chromium",
        "chromium-browser",
    ]
    for candidate in candidates:
        if candidate and shutil.which(candidate):
            return candidate
    raise RuntimeError("No Chrome/Chromium binary found for browser harness")


def wait_for_json(url, timeout=20):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                return json.loads(response.read().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - diagnostics are reported below.
            last_error = error
            time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


def cdp(ws, method, params=None, counter=[0]):
    counter[0] += 1
    message_id = counter[0]
    ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
    while True:
        message = json.loads(ws.recv())
        if message.get("id") == message_id:
            if "error" in message:
                raise RuntimeError(message["error"])
            return message.get("result", {})


def eval_js(ws, expression, await_promise=False):
    result = cdp(ws, "Runtime.evaluate", {
        "expression": expression,
        "awaitPromise": await_promise,
        "returnByValue": True,
        "userGesture": True,
    })
    if "exceptionDetails" in result:
        raise RuntimeError(result["exceptionDetails"])
    return result.get("result", {}).get("value")


def inject_extension_stubs(ws, settings, language_model_mock="", local_store=None):
    local_store = local_store or {}
    stub = f"""
      window.__spoiltSettings = {json.dumps(settings)};
      window.__spoiltLocalStore = {json.dumps(local_store)};
      window.__spoiltStorageListeners = [];
      window.chrome = {{
        runtime: {{
          onMessage: {{ addListener(listener) {{ window.__spoiltMessageListener = listener; }} }},
          async sendMessage(message) {{
            if (message && message.type === "fetchImageDataUrl") {{
              return {{ ok: false, error: "mock fetch unavailable" }};
            }}
            return {{ ok: true }};
          }}
        }},
        storage: {{
          sync: {{
            async get(key) {{ return {{ [key]: window.__spoiltSettings }}; }},
            async set(_value) {{}}
          }},
          local: {{
            _store: window.__spoiltLocalStore,
            async get(key) {{
              if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, this._store[item]]));
              return {{ [key]: this._store[key] }};
            }},
            async set(value) {{ Object.assign(this._store, value); }}
          }},
          onChanged: {{ addListener(listener) {{ window.__spoiltStorageListeners.push(listener); }} }}
        }}
      }};
      window.__spoiltSetSettings = (nextSettings) => {{
        const oldValue = window.__spoiltSettings;
        window.__spoiltSettings = nextSettings;
        for (const listener of window.__spoiltStorageListeners) {{
          listener({{ "spoilt.settings": {{ oldValue, newValue: nextSettings }} }}, "sync");
        }}
      }};
      {language_model_mock}
    """
    eval_js(ws, stub)
    css = (ROOT / "src/content.css").read_text(encoding="utf-8")
    eval_js(ws, "const style = document.createElement('style'); style.textContent = " + json.dumps(css) + "; document.head.appendChild(style);")
    for script_name in ["src/shared.js", "src/memory.js", "src/content.js"]:
        script = (ROOT / script_name).read_text(encoding="utf-8")
        eval_js(ws, script)


def main():
    os.chdir(ROOT)
    server = socketserver.TCPServer(("127.0.0.1", PORT), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    profile = tempfile.TemporaryDirectory(prefix="spoilt-chrome-")
    debug_port = free_port()
    chrome = subprocess.Popen([
        chrome_binary(),
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"--user-data-dir={profile.name}",
        f"--remote-debugging-port={debug_port}",
        "--remote-allow-origins=*",
        URL,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    try:
        tabs = wait_for_json(f"http://127.0.0.1:{debug_port}/json/list")
        page = next(tab for tab in tabs if tab.get("type") == "page")
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=5)
        cdp(ws, "Runtime.enable")
        cdp(ws, "Page.enable")
        time.sleep(0.5)

        settings = {
            "enabled": True,
            "useLocalAI": False,
            "useVision": False,
            "scanText": True,
            "scanImages": True,
            "strictness": "balanced",
            "rules": [{
                "id": "plot-spoilers",
                "name": "Plot spoilers",
                "description": "Story endings, deaths, reveals, twists, episode recaps, leaks, and major plot outcomes.",
                "keywords": ["spoiler", "ending", "death", "finale", "leak"],
            }],
        }
        inject_extension_stubs(ws, settings)
        time.sleep(2.2)
        counts = eval_js(ws, "({ text: document.querySelectorAll('.spoilt-redacted-text').length, images: document.querySelectorAll('.spoilt-image-shell').length, safeReadable: document.body.textContent.includes('This paragraph is safe') })")
        if counts["text"] < 2 or counts["images"] < 1 or not counts["safeReadable"]:
            raise AssertionError(f"Unexpected mask counts: {counts}")

        updated_settings = dict(settings)
        updated_settings["rules"] = [{
            "id": "safe-text",
            "name": "Safe text regression check",
            "description": "Used by the E2E test to verify rule changes rescan previously processed text.",
            "keywords": ["paragraph is safe"],
        }]
        eval_js(ws, f"window.__spoiltSetSettings({json.dumps(updated_settings)})")
        time.sleep(1.3)
        rule_change_counts = eval_js(ws, "({ text: document.querySelectorAll('.spoilt-redacted-text').length, safeMasked: Array.from(document.querySelectorAll('.spoilt-redacted-text')).some((node) => node.textContent.includes('safe')) })")
        if rule_change_counts["text"] < 3 or not rule_change_counts["safeMasked"]:
            raise AssertionError(f"Rule-change rescan failed: {rule_change_counts}")

        disabled_settings = dict(updated_settings)
        disabled_settings["enabled"] = False
        eval_js(ws, f"window.__spoiltSetSettings({json.dumps(disabled_settings)})")
        time.sleep(0.4)
        disabled_counts = eval_js(ws, "({ text: document.querySelectorAll('.spoilt-redacted-text').length, images: document.querySelectorAll('.spoilt-image-shell').length, safeReadable: document.body.textContent.includes('This paragraph is safe'), spoilerReadable: document.body.textContent.includes('Major spoiler') })")
        if disabled_counts["text"] != 0 or disabled_counts["images"] != 0 or not disabled_counts["safeReadable"] or not disabled_counts["spoilerReadable"]:
            raise AssertionError(f"Disable unmask failed: {disabled_counts}")

        cdp(ws, "Page.navigate", {"url": URL})
        time.sleep(0.8)
        semantic_settings = {
            "enabled": True,
            "useLocalAI": True,
            "useVision": False,
            "scanText": True,
            "scanImages": False,
            "strictness": "balanced",
            "rules": [{
                "id": "semantic-plot",
                "name": "Plot outcome",
                "description": "Block sentences that reveal the detective was the ghost.",
                "keywords": [],
            }],
        }
        language_model_mock = """
          window.LanguageModel = {
            async availability() { return "available"; },
            async create() {
              return {
                async prompt(promptText) {
                  const snippets = JSON.parse(promptText.match(/Snippets:\\n([\\s\\S]*)$/)[1]);
                  return JSON.stringify({
                    decisions: snippets.map((snippet) => ({
                      i: snippet.i,
                      block: snippet.text.includes("detective was the ghost"),
                      rule: "Plot outcome",
                      reason: "mock semantic description match"
                    }))
                  });
                },
                destroy() {}
              };
            }
          };
        """
        inject_extension_stubs(ws, semantic_settings, language_model_mock)
        time.sleep(1.2)
        semantic_counts = eval_js(ws, "({ text: document.querySelectorAll('.spoilt-redacted-text').length, semanticMasked: Array.from(document.querySelectorAll('.spoilt-redacted-text')).some((node) => node.textContent.includes('detective was the ghost')) })")
        if semantic_counts["text"] < 1 or not semantic_counts["semanticMasked"]:
            raise AssertionError(f"Description-only semantic AI masking failed: {semantic_counts}")

        cdp(ws, "Page.navigate", {"url": URL})
        time.sleep(0.8)
        recovering_language_model_mock = """
          window.__spoiltCreatedSessions = 0;
          window.LanguageModel = {
            async availability() { return "available"; },
            async create() {
              window.__spoiltCreatedSessions += 1;
              const sessionNumber = window.__spoiltCreatedSessions;
              return {
                async prompt(promptText) {
                  if (sessionNumber === 1) {
                    const error = new DOMException("Failed to execute 'prompt' on 'LanguageModel': The model execution session has been destroyed.", "InvalidStateError");
                    throw error;
                  }
                  const snippets = JSON.parse(promptText.match(/Snippets:\\n([\\s\\S]*)$/)[1]);
                  return JSON.stringify({
                    decisions: snippets.map((snippet) => ({
                      i: snippet.i,
                      block: snippet.text.includes("detective was the ghost"),
                      rule: "Plot outcome",
                      reason: "mock recovered session"
                    }))
                  });
                },
                destroy() {}
              };
            }
          };
        """
        inject_extension_stubs(ws, semantic_settings, recovering_language_model_mock)
        time.sleep(1.6)
        recovery_counts = eval_js(ws, "({ text: document.querySelectorAll('.spoilt-redacted-text').length, semanticMasked: Array.from(document.querySelectorAll('.spoilt-redacted-text')).some((node) => node.textContent.includes('detective was the ghost')), sessions: window.__spoiltCreatedSessions, status: window.__spoiltLocalStore['spoilt.status'] })")
        if recovery_counts["text"] < 1 or not recovery_counts["semanticMasked"] or recovery_counts["sessions"] < 2:
            raise AssertionError(f"Destroyed-session recovery failed: {recovery_counts}")

        print(f"e2e_chrome.py passed: initial={counts} rule_change={rule_change_counts} disabled={disabled_counts} semantic={semantic_counts} recovery={recovery_counts}")
    finally:
        try:
            chrome.terminate()
            chrome.wait(timeout=5)
        except Exception:
            chrome.kill()
        server.shutdown()
        profile.cleanup()


if __name__ == "__main__":
    main()
