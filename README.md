# Spoilt

Spoilt is a Chrome extension that blacks out user-configured spoilers or unwanted content before you read it. It uses Chrome's local `LanguageModel` Prompt API when available and falls back to local keyword, title, and alt-text matching when the model or image modality is unavailable.

## What It Does

- Lets users define blocking rules with a name, description, and keywords.
- Masks matching text with blacked-out spans.
- Masks matching images with black placeholder shells.
- Uses Chrome local inference for semantic text classification when `LanguageModel` is already available.
- Provides a **Prepare local AI** popup action to trigger Chrome model download/preparation from a user gesture.
- Uses rule names/descriptions as a conservative fallback when the local model is unavailable, so description-only rules can still catch direct terms.
- Uses Chrome local image input when available; otherwise it checks image `alt`, `title`, ARIA label, caption, poster URL, and source metadata.
- Sends no page content to a remote server. AI checks run through Chrome's on-device model APIs.

## Requirements

- Chrome 138 or newer for text Prompt API support.
- Image understanding depends on the Chrome version/channel and device support for Prompt API image input.
- Gemini Nano may need to download on first use. Chrome's documentation says the initial model download needs an unmetered connection, and subsequent use does not send data to Google or third parties.

## Install Locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository folder.
5. Open the Spoilt options page and configure your rules.

## Usage

- Click the toolbar icon to enable or disable protection, prepare local AI, rescan the current tab, or open options.
- Click **Prepare local AI** after install or Chrome updates if text AI or vision status is `downloadable`, `downloading`, or unavailable.
- Add specific rules. Good rule descriptions include what to block and what not to block.
- Add direct keywords for immediate masking even when Chrome local AI is unavailable.

Example rules:

- `Formula 1 results`: block race winners, podiums, qualifying results, and championship standings.
- `Movie spoilers`: block endings, character deaths, twists, leaks, and post-credit scene details.
- `Medical anxiety`: block graphic medical procedure descriptions and images.

## Development

This project has no runtime dependencies. If Node is installed:

```bash
npm test
```

In this Windows/WSL workspace, Node may be available at:

```bash
"/mnt/c/Program Files/nodejs/node.exe" tests/shared.test.cjs
"/mnt/c/Program Files/nodejs/node.exe" tests/manifest.test.cjs
```

Package a zip:

```bash
zip -r spoilt-extension.zip manifest.json src icons README.md LICENSE
```

## Privacy

Spoilt stores settings in `chrome.storage.sync` and per-tab status in `chrome.storage.local`. It does not include analytics, network calls, remote APIs, or external dependencies.

## Release Notes

`1.0.2` fixes local-AI lifecycle issues: passive page scans no longer start model downloads, the popup can prepare local AI from a user gesture, description-only rules get fallback matching, and CI covers semantic AI masking with a mocked Prompt API. Chrome Web Store publication requires creating store listing assets and completing Google's developer account workflow.

## License

MIT
