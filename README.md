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
- **A background-managed AI lease** so tabs cannot compete for the same on-device model session.
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

## Link Prefetching

Enable **Prefetch likely links** in settings to warm the browser's HTTP cache after
120 ms of mouse hover or keyboard focus. This is a content-script implementation;
it does not require Chrome's prediction APIs or additional extension permissions.
It also works for links added after page load.

Only same-origin HTTP(S) links are eligible. Query strings, current-page anchors,
downloads, non-HTML file paths, common account/action paths, links with `ping`,
`nofollow`, `external`, a named-frame target, or a `data-no-prefetch` ancestor are skipped.
Ordinary new-tab links are eligible, and the new tab may reuse its actual
opener's prepared result for the same destination.
Requests run one at a time, at most eight per document, with a five-second timeout
and a 1 MB response-body read limit. Hidden pages, offline mode, Save-Data, and
reported 2G/3G connections suppress work. Disabling protection or prefetching aborts
pending work. Redirects are not followed and fetched HTML is never executed.

Spoilt checks up to 700 static text fragments against your keywords, rule
descriptions, and recent knowledge before navigation, prioritizing article content.
When on-device analysis is enabled and available, it also analyzes up to 72
remaining text fragments and three ordinary same-origin images. Direct matches are
saved immediately, and semantic matches are saved after each model batch.
Prepared positive decisions are kept in Chrome session storage,
scoped to the source tab and tabs opened from it. Decisions expire after 60
seconds and are scheduled for removal. On navigation, matching text and image
URLs are concealed as the document is constructed. The extension
briefly covers the page while it checks for prepared decisions, with a 500 ms
fail-open timeout to avoid leaving pages blank. It discards decisions if the
boundaries or recent knowledge changed. Image metadata is checked locally even
for CDN and responsive images. Pixel analysis still excludes `srcset`, cross-origin
URLs, query strings, and `no-store` responses. Images that load after the initial
scan are checked again when they finish loading.

Preparation is best effort: the model may not be available or may not finish
before navigation, and dynamic content, changed text, images, and sites that do
not allow their HTML to be cached still rely on normal page scanning. It cannot
guarantee concealment before every frame. Navigation remains native, and cache
reuse depends on server cache headers, `Vary`, and browser policy. The response
limit bounds bytes read by Spoilt, not bytes already buffered by Chrome.

### Hydration and live decisions

Direct rules and exact prepared decisions are reapplied in mutation callbacks,
independently of the serialized AI scan. A framework may replace the text nodes,
split an exact headline across inline markup, or replace the document body without
losing a known decision. Live AI decisions also enter this same reapplication path.
The extension does not reuse semantic decisions for substrings or whole articles.
Changed text and image metadata are checked again; delayed AI responses cannot
conceal a different snapshot or a different route.

Live positive decisions are kept in memory for the current page and in trusted
Chrome session storage for up to 60 seconds for a reload of that exact URL in the
same tab. The URL includes its query and hash. The cache holds at most 700 text
decisions and 300 image-source decisions per tab, and is invalidated by boundary,
analysis-mode, or recent-knowledge changes. SPA route changes discard the active
decisions. Live reuse does not enable link prefetching or make network requests.

The initial page cover has a 500 ms deadline. If startup is still pending, the page
becomes usable with a dismissible notice that unchecked content may be visible.
Startup failure also produces a notice. New semantic content without a valid
prepared/live decision still needs on-device analysis and can appear before its
result. Expired caches, unsupported browser pages, shadow DOM, canvas text,
cross-origin frames, page scripts that change content during rendering, and sites
that override concealment styles are outside the no-exposure cases tested here.

Run `npm run test:hydration` after building for frame samples covering known
decisions, split-node hydration, a busy model, reloads, cache expiry, route changes,
stale AI results, and direct-rule mutations. The synthetic model is deliberately
slow; this tests extension timing, not the native model's classification accuracy.

Live concealment does not depend on cache admission: an unchanged AI-positive text
node longer than the 4,000-character reuse limit is still concealed immediately.
Inline aggregation excludes code, hidden/editable content and other skipped
subtrees, and is bounded to 64 descendant nodes. Mutation roots are coalesced;
cosmetic root attributes do not synchronously trigger full-page scans. Traversal
uses bounded chunks based on the enabled scan budgets, with remaining large-page
work deferred and new small changes prioritized. Content beyond a chunk's budget
can wait for a continuation. Speculative image downloads have at most three
attempts and a five-second total download deadline, including failed responses.
