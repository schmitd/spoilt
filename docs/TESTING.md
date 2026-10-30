# Testing Spoilt

Spoilt uses three release gates.

## Unit and Component Tests

```bash
npm run test:unit
```

Vitest covers settings migration, matching, model-output parsing, spoiler-memory behavior, popup hierarchy, conditional options controls, undo, and saving concealment styles.

## Production Build

```bash
npm run typecheck
npm run build
```

WXT generates the MV3 manifest and all extension entrypoints in `.output/chrome-mv3/`. TypeScript runs in strict mode. The full test command also validates the generated manifest, including the full-tab options page.

## Real Extension Smoke Test

```bash
npm run test:browser
```

The Playwright harness:

- launches the production build as an unpacked extension in a persistent Chromium context;
- discovers the generated extension ID from the service worker;
- verifies popup and options content in the real extension origin;
- checks desktop and narrow layouts for horizontal overflow;
- confirms the content script conceals deterministic and late-injected spoilers;
- verifies image concealment;
- verifies only one extension context can use the on-device model at a time;
- injects a model-session creation failure through Chrome DevTools and confirms it becomes a recoverable, non-persistent state;
- switches between whiteout and marker treatments;
- disables protection and confirms all masks are removed;
- re-enables protection and confirms the page is concealed again;
- fails on page exceptions or console errors.

On Windows, run the script with Windows Node to also produce screenshots:

```powershell
node tests/extension-smoke.mjs
```

Screenshots are written to `.artifacts/release/`.

## Hydration and frame exposure regression

```bash
npm run build
npm run test:hydration
```

This loads the production extension in a temporary headless Chromium profile and
uses synthetic localhost pages and a 600–900 ms isolated-world model mock. A
`requestAnimationFrame` sampler inspects actual computed concealment styles on
every sampled text fragment. Positive cases require zero exposed sampled frames;
they also require sampled frames to exist, so an eventual mask alone cannot pass.

Coverage includes prepared navigation, an exact headline split across inline
markup, repeated hydration while another model request is busy, same-tab live
cache reload, direct-rule mutations, and editable descendants. A stale AI snapshot
must leave changed safe text visible. Route changes and expired-cache controls
must allow unknown semantic text to remain visible rather than silently reusing
an unrelated decision. In-flight results from the old route must be discarded.

Frame logs and a screenshot are written to `.artifacts/hydration/`. Logs label the
intentional visible controls separately from protected cases. The sampler is a
render-timing regression, not a universal proof of no flash: it cannot verify all
sites, native-model accuracy, browser UI pages, frames, shadow DOM, canvas text, or
changes made later in a page's own animation-frame callback. Manual verification
with the user's native Chrome model and an explicitly approved extension reload
remains a separate step.

Review regressions additionally verify that a positive live AI result over 4,000
normalized characters is concealed even though it is not admitted to the reuse
cache; code/hidden descendants cannot trigger masks over safe visible prose;
repeated root class/style changes do not synchronously rewalk unchanged subtrees;
large revealed subtrees finish in bounded continuation chunks while new small
changes retain priority; and failed, `no-store`, or oversized speculative images
consume the same three-attempt budget as successful downloads.

Continuation regressions remove a queued sibling, or the visited node together
with adjacent queued siblings, between traversal chunks. A cached match later in
the same connected subtree must still be reached. The browser variant seeds the
decision cache and then disables the model so another AI scan cannot hide a lost
continuation position.

## Full Gate

The performance integration gate (`npm run test:performance`) loads the production
extension in a temporary sandboxed Chromium profile with a deterministic cloned
model. It verifies session reuse, exact decision reuse, positive/negative controls
and configuration invalidation, and writes numeric evidence under
`.artifacts/performance/`. It does not establish native model accuracy or GPU speed.

Label regressions cover direct and image-metadata prefilters, opaque AI attribution,
title-only rules, explicit keywords equal to a title, in-flight renames, prepared/live
cache reuse, and criterion-bound recent knowledge. The production-browser case
renames an active boundary, verifies masks and model-call counts stay unchanged,
and confirms title text alone remains visible. Real criterion edits still invalidate
the old decisions.

```bash
npm test
```

This runs unit/component and manifest tests, the production build, the real extension
smoke test, frame/hydration regressions, and the performance integration gate.
