#!/usr/bin/env python3
"""Optional live-site harness for Spoilt.

Usage:
  python3 tests/wild_harness.py --url https://example.com --url https://news.google.com/search?q=movie+spoiler

This is intentionally not part of default CI because live sites, bot defenses,
network state, and ML model availability are non-deterministic.
"""

import argparse
import json
import pathlib
import subprocess
import tempfile
import time
import urllib.request

import websocket

from e2e_chrome import cdp, chrome_binary, eval_js, free_port, inject_extension_stubs, wait_for_json

ROOT = pathlib.Path(__file__).resolve().parents[1]

SETTINGS = {
    "enabled": True,
    "useLocalAI": False,
    "useVision": False,
    "scanText": True,
    "scanImages": True,
    "strictness": "balanced",
    "memoryEnabled": True,
    "rules": [{
        "id": "wild-spoilers",
        "name": "Wild spoiler smoke test",
        "description": "Movie endings, sports winners, leaks, finale deaths, surprise reveals, and plot twists.",
        "keywords": ["spoiler", "ending", "winner", "leak", "finale", "death", "twist", "reveals"],
    }],
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", action="append", required=True, help="Live URL to scan")
    parser.add_argument("--wait", type=float, default=2.5)
    args = parser.parse_args()

    profile = tempfile.TemporaryDirectory(prefix="spoilt-wild-")
    debug_port = free_port()
    chrome = subprocess.Popen([
        chrome_binary(),
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        f"--user-data-dir={profile.name}",
        f"--remote-debugging-port={debug_port}",
        "--remote-allow-origins=*",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

    try:
      tabs = wait_for_json(f"http://127.0.0.1:{debug_port}/json/list")
      page = next(tab for tab in tabs if tab.get("type") == "page")
      ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=5)
      cdp(ws, "Runtime.enable")
      cdp(ws, "Page.enable")
      for url in args.url:
          cdp(ws, "Page.navigate", {"url": url})
          time.sleep(args.wait)
          inject_extension_stubs(ws, SETTINGS)
          time.sleep(args.wait)
          result = eval_js(ws, "({ url: location.href, title: document.title, masks: document.querySelectorAll('.spoilt-redacted-text').length, imageMasks: document.querySelectorAll('.spoilt-image-shell').length, status: window.chrome.storage.local._store['spoilt.status'] || {} })")
          print(json.dumps(result, sort_keys=True))
    finally:
      try:
          chrome.terminate()
          chrome.wait(timeout=5)
      except Exception:
          chrome.kill()
      profile.cleanup()


if __name__ == "__main__":
    main()
