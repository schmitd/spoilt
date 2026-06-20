# Spoilt

Spoilt is a privacy-first Chrome extension for creating healthy boundaries around spoilers and unwanted content. It checks visible text and images against user-defined rules, then replaces matching content with tactile whiteout or marker treatments before it is read.

## Product Principles

- **Local first:** page content is not sent to a remote server.
- **Boundaries without alarm:** the interface is calm, explicit, and reversible.
- **Useful without AI:** keyword and rule-description matching always work.
- **Progressive enhancement:** Chrome's on-device Prompt API improves semantic text and image matching when available.
- **Transparent memory:** optional public-news lookups keep active subjects current and store the resulting references locally.

## Architecture

Spoilt uses:

- **WXT** for MV3 manifest generation, entrypoints, builds, and packaging.
- **Preact + TypeScript** for popup and settings UI.
- **Typed domain modules** for settings, matching, model JSON, memory, and status.
- **Typed browser adapters** for storage and messages.
- **Dedicated services** for local AI and memory refresh.
- **A decomposed content runtime** with candidate collection, redaction, AI classification, and orchestration boundaries.

Effect.ts is intentionally not part of the runtime. The current lifecycle and error model are handled with typed boundaries and small services; adding another runtime would increase bundle and maintenance cost without solving an unmet problem.

## Development

Requirements:

- Node.js 20.12 or newer
- Chrome 138 or newer for the production extension

Install and start WXT:

```bash
npm install
npm run dev
```

WXT prints the development output path. Load that unpacked directory from `chrome://extensions` if the browser does not open automatically.

## Build and Test

```bash
npm run typecheck
npm test
```

See [docs/TESTING.md](docs/TESTING.md) for the complete release gates.
See [docs/RELEASE.md](docs/RELEASE.md) for the store and manual review checklist.

## Package

```bash
npm run zip
```

WXT writes the Chrome package under `.output/`.

## Privacy

Settings are stored in `chrome.storage.sync`. Operational status and recent spoiler knowledge are stored in `chrome.storage.local`.

The optional memory feature sends queries derived from configured boundaries to Google News RSS. It does not upload page content. Disable **Keep recent knowledge up to date** to stop periodic public lookups.

See [PRIVACY.md](PRIVACY.md) for the complete data-use and permission disclosure.

## Loading a Production Build

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select `.output/chrome-mv3`.

## License

MIT
