# Native acceptance

The deterministic release gate uses synthetic model replies. Its timings measure
orchestration, not native GPU throughput. A green release gate alone does not
establish native model readiness, semantic accuracy or a device speedup.

## Existing installed profile

Save any settings edits first. Use Chrome's supported extension Reload control
only when it will not discard edits or interrupt active analysis. Reopen the
packaged analysis window and refresh the controlled test page after a reload.
Match the installed files and the analysis page's loaded script asset to the
release receipt; an unchanged manifest version alone is insufficient evidence.

Inspect `chrome://on-device-internals` in the intended existing profile to check
model and broker state. Do not change feature flags or browser permissions to
make a test pass. Chrome manages models itself and can download/update them in
the background; even `availability()` can trigger model management in a fresh
profile. Do not describe an API check as an unconditional zero-download promise.

Use ordinary DevTools on Spoilt's own top-level `analysis.html` document, never
on a private browsing page. Feature-detect `LanguageModel`; check text and image
availability separately with the same language/input options as the extension.
Call `create()` only when availability is `available`. Do not click Prepare for
a download during a test whose scope excludes downloads. Bound every operation
with an abort signal and destroy every created session or clone in `finally`.

A completed harmless text prompt verifies text inference. A generated solid-color
canvas with a correct response verifies image inference separately. API presence,
component files, an adapter name, or a session creation without a completed prompt
does not establish inference. Keep user page text, settings, model replies and
screenshots of unrelated pages out of the report.

## Production semantic acceptance

`node tests/native-ai-smoke.mjs --preflight-only` checks the fixtures with the
actual direct matchers, without launching Chrome or probing a model.

`npm run test:native` runs a separate native acceptance in a fresh temporary
Chromium profile. It does not copy the user's profile or request model preparation.
Its result belongs to that profile; it does not prove the installed normal
profile is working. If the model is missing or not already available, report the
blocker rather than downloading it or substituting mocked model output.

The production-route check must establish all of the following:

1. The positive and safe fixtures have no keyword or description fallback match.
2. A real production engine inference and successful response are recorded after
   the controlled page is opened. A separate direct capability probe is not proof
   that production routing used the model.
3. The semantic positive is concealed and safe prose remains visible.
4. A repeat with distinct synthetic text runs inference through an independent
   disposable session or clone. Record whether cloning was used, along with
   configuration, modality and cache state.
5. Image behavior is checked independently when supported, or reported as an
   explicit unsupported/unavailable limitation.

First/repeat session, cloning, inference and total request times may be recorded
as numeric diagnostics. A first request after a capability probe is not a forced
GPU cold start. Duplicate-cache hits are not warm inference samples. Different
triggers or fixtures must not be divided into an unsupported speedup ratio.

## Acceptance record

Record UTC date, Chrome version, profile type, source commit, ZIP hash, installed
asset identity, model availability, completed capability checks, production
positive/safe results, first/repeat phase durations, image outcome and cleanup.
State whether any model preparation/download was explicitly requested, while
distinguishing Chrome's independent model management. Record unavailable or
unexecuted checks as such; do not turn them into passes.

References:
[Prompt API](https://developer.chrome.com/docs/ai/prompt-api),
[model management](https://developer.chrome.com/docs/ai/understand-built-in-model-management),
[session management](https://developer.chrome.com/docs/ai/session-management),
[extension debugging](https://developer.chrome.com/docs/extensions/get-started/tutorial/debug).
