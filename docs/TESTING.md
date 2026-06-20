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

## Full Gate

```bash
npm test
```

This runs unit/component tests, the production build, and the real extension smoke test.
