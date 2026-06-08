# Spoilt

Spoilt is a Chrome extension that blacks out user-configured spoilers or unwanted content before you read it. It combines immediate deterministic matching, local Chrome AI when available, and a periodic spoiler-memory loop that searches for fresh details about each configured subject.

## Product Identity

Spoilt now uses a **redaction bureau** identity: stark ink surfaces, dossier-yellow status signals, hard-edged controls, and editorial typography. The interface is intentionally more like an intelligence desk than a generic settings panel because the product promise is vigilance.

The Impeccable-derived design skills (`bolder`, `distill`, `polish`, plus companion critique/delight/quieter skills) were installed locally from `irastorzatobias/design-skills`. Restart Codex to make them auto-trigger in future turns.

## What It Does

- Lets users define blocking rules with a name, description, and keywords.
- Masks matching text with blacked-out spans.
- Masks matching images with black placeholder shells.
- Searches roughly every 12 hours for each rule and stores fresh spoiler details in local extension memory.
- Stores labeled image examples as metadata, including why each image is likely a spoiler.
- Adds memory details and image examples to local AI prompts as few-shot context.
- Uses Chrome local inference for semantic text/image classification when `LanguageModel` is already available.
- Uses a **Prepare local AI** popup action to trigger model download/preparation from a user gesture.
- Uses rule names/descriptions and memory terms as conservative fallbacks when local AI is unavailable.
- Avoids Google Images/cross-origin taint failures by fetching remote image bytes through the extension service worker and passing `Blob` inputs to the local VLM when possible.
- Sends no page content to a remote server. Periodic memory refresh uses public web/news search results for the configured subjects and stores summaries locally.

## Requirements

- Chrome 138 or newer for text Prompt API support.
- Image understanding depends on Chrome version/channel and device support for Prompt API image input.
- Gemini Nano may need to download on first use. Chrome's documentation says the initial model download needs an unmetered connection, and subsequent use does not send data to Google or third parties.

## Install Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open Spoilt options and configure your rules.
6. Click the Spoilt toolbar icon and choose **Prepare local AI** if you want semantic local AI/VLM support.

## Usage

- Click the toolbar icon to enable or disable protection, prepare local AI, refresh memory, rescan the current tab, or open options.
- Keep memory refresh enabled for subjects where new details appear over time, such as active TV seasons, sports, elections, or game releases.
- Add specific rules. Good descriptions include what to block and what not to block.
- Add direct keywords for immediate masking even when Chrome local AI is unavailable.

Example rules:

- `Formula 1 results`: block race winners, podiums, qualifying results, and championship standings.
- `Movie spoilers`: block endings, character deaths, twists, leaks, and post-credit scene details.
- `Medical anxiety`: block graphic medical procedure descriptions and images.

## Development

This project has no runtime dependencies. The full test suite uses Node plus Python and Chrome:

```bash
npm test
```

Useful targets:

```bash
npm run test:unit
npm run test:e2e
npm run test:adversarial
npm run test:wild -- --url "https://news.google.com/search?q=movie%20spoiler"
```

In this Windows/WSL workspace, Node may be available at:

```bash
"/mnt/c/Program Files/nodejs/node.exe" tests/shared.test.cjs
"/mnt/c/Program Files/nodejs/node.exe" tests/memory.test.cjs
"/mnt/c/Program Files/nodejs/node.exe" tests/manifest.test.cjs
```

Package a zip:

```bash
zip -r spoilt-extension.zip manifest.json src icons README.md LICENSE docs
```

See [docs/TESTING.md](docs/TESTING.md) for the harness strategy.

## Privacy

Spoilt stores settings in `chrome.storage.sync` and operational memory/status in `chrome.storage.local`. It does not include analytics or a remote service. The memory loop fetches public search/news result pages for configured subjects; disable **Refresh spoiler memory from web search** if you want no periodic web lookups.

## Release Notes

`1.1.4` fixes stale local-AI downloading status after Chrome finishes preparing a model session. `1.1.3` made the popup and options UI more compact. `1.1.2` separated malformed local-model JSON output from true model availability failures and accepts fenced JSON responses. `1.1.1` added recovery for Chrome Prompt API sessions that expire or are destroyed during page scans. `1.1.0` added periodic spoiler memory, labeled image examples, safer VLM image loading, a redesigned redaction-bureau UI, and deterministic adversarial/wild test harnesses. Chrome Web Store publication requires creating store listing assets and completing Google's developer account workflow.

## License

MIT
