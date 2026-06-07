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
import socketserver
import subprocess
import tempfile
import threading
import time
import urllib.request

import websocket

ROOT = pathlib.Path(__file__).resolve().parents[1]
PORT = 8776
DEBUG_PORT = 9226
URL = f"http://127.0.0.1:{PORT}/tests/test-page.html"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def wait_for_json(url, timeout=10):
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


def main():
    os.chdir(ROOT)
    server = socketserver.TCPServer(("127.0.0.1", PORT), QuietHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    profile = tempfile.TemporaryDirectory(prefix="spoilt-chrome-")
    chrome = subprocess.Popen([
        "google-chrome-stable",
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"--user-data-dir={profile.name}",
        f"--remote-debugging-port={DEBUG_PORT}",
        "--remote-allow-origins=*",
        URL,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    try:
        tabs = wait_for_json(f"http://127.0.0.1:{DEBUG_PORT}/json/list")
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
        stub = f"""
          window.chrome = {{
            runtime: {{ onMessage: {{ addListener() {{}} }} }},
            storage: {{
              sync: {{
                async get(key) {{ return {{ [key]: {json.dumps(settings)} }}; }},
                async set(_value) {{}}
              }},
              local: {{
                _store: {{}},
                async get(key) {{ return {{ [key]: this._store[key] }}; }},
                async set(value) {{ Object.assign(this._store, value); }}
              }},
              onChanged: {{ addListener() {{}} }}
            }}
          }};
        """
        eval_js(ws, stub)
        css = (ROOT / "src/content.css").read_text(encoding="utf-8")
        eval_js(ws, "const style = document.createElement('style'); style.textContent = " + json.dumps(css) + "; document.head.appendChild(style);")
        script = (ROOT / "src/content.js").read_text(encoding="utf-8")
        eval_js(ws, script)
        time.sleep(2.2)
        counts = eval_js(ws, "({ text: document.querySelectorAll('.spoilt-redacted-text').length, images: document.querySelectorAll('.spoilt-image-shell').length, safeReadable: document.body.textContent.includes('This paragraph is safe') })")
        if counts["text"] < 2 or counts["images"] < 1 or not counts["safeReadable"]:
            raise AssertionError(f"Unexpected mask counts: {counts}")
        print(f"e2e_chrome.py passed: {counts}")
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
