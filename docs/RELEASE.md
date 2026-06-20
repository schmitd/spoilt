# Release Checklist

## Automated Gate

Run:

```bash
npm ci
npm run test:release
```

The release gate checks TypeScript, unit and component behavior, a production WXT build, the unpacked extension in Chromium, dependency advisories, and the final Chrome zip.

## Manual Browser Checks

1. Load `.output/chrome-mv3` in the oldest supported Chrome version.
2. Confirm the toolbar icon and popup render at 100% and 200% scaling.
3. Open settings from the popup and confirm it opens in a full tab.
4. Test keyboard-only rule editing, save, undo, reset, and advanced controls.
5. Test whiteout and marker concealment on text, linked images, dynamically inserted content, and a page with restrictive styles.
6. Confirm disabling protection removes existing concealment immediately.
7. Confirm the extension remains useful when the on-device Prompt API is unavailable.
8. Enable recent knowledge, run a manual refresh, inspect its status, clear it, then disable it.

## Chrome Web Store

- Upload the zip generated under `.output/`.
- Use the 128px icon from `public/icon/`.
- Upload current popup, settings, and concealment screenshots from `.artifacts/release/`.
- Publish the contents of `PRIVACY.md` at a stable public URL and use that URL in the listing.
- Explain `<all_urls>` as necessary to protect content on sites the user visits and retrieve images for local analysis.
- Explain that optional Google News queries are derived from user-defined boundaries; page content is not sent to Spoilt servers.
- Complete the store data-use disclosure consistently with `PRIVACY.md`.
- Verify the listing does not imply Chrome's on-device Prompt API is available on every device.

## Versioning

Keep the version in `package.json` and `wxt.config.ts` aligned. Re-run the full release gate after any version or manifest change.
