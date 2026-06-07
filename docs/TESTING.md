# Spoilt Test Harness

Spoilt uses a layered harness because this extension is both a DOM transformer and an ML-assisted classifier.

## Layers

- `npm run test:unit`: pure JavaScript tests for settings, memory parsing, memory merging, and manifest wiring.
- `npm run test:e2e`: Chrome/CDP browser test that injects the real extension scripts into a controlled fixture.
- `npm run test:adversarial`: deterministic stress scenarios for hostile web behavior: prompt-injection text, late DOM mutation, memory-only spoilers, and Google Images-style cross-origin image fallback.
- `npm run test:wild -- --url <url>`: optional live-site smoke scans. This is not run in CI because live sites, bot defenses, and model availability are non-deterministic.

## Why This Mechanism

Chrome's official extension testing guidance points to browser E2E tools such as Puppeteer and Playwright. Playwright's extension docs note that extensions work in Chromium persistent contexts and expose MV3 service workers for testing. That is the right long-term library if this project grows into a full TypeScript test suite.

For this dependency-light repo, the current harness uses Chrome DevTools Protocol directly from Python. That avoids a browser download and still tests the actual browser DOM, mutation observer behavior, storage stubs, and local Prompt API integration shape.

Agentic QA tools such as Browser Use / qa-use are useful for broad exploratory testing, but they require external service/API keys and introduce non-determinism. Spoilt keeps deterministic adversarial tests in CI and leaves live/wild scans as an explicit manual command.

## Wild Scan Example

```bash
python3 tests/wild_harness.py --url "https://news.google.com/search?q=movie%20spoiler"
```

Read the output as telemetry, not a pass/fail oracle. Live pages change constantly and may block automation.
