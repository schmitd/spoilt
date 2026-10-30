# On-device analysis

Spoilt uses Chrome's built-in Prompt API for local semantic text and image classification. Keyword, description, and optional recent-knowledge matching remain available when the native model cannot run. A Chrome version alone does not establish model availability: hardware, disk space, profile eligibility, and Chrome's model state also matter.

Boundary titles are organizational labels. Native prompts contain criteria and
opaque boundary aliases, never display names. The extension maps an alias to its
stable rule ID and current display name only after classification. Name-only edits
refresh labels while preserving in-flight work, decisions and fixed-context
sessions. A boundary with no description or explicit keywords is inactive for
matching, even if it has a name.

## Setup

1. Enable **Use on-device analysis** in Manage boundaries. Image analysis is optional.
2. Open Spoilt's popup, expand **Protection details**, and choose **Prepare on-device analysis**. This opens or restores a compact Spoilt analysis window. An older analysis tab is moved into that window without closing its live document.
3. Read the download disclosure. If a model needs downloading, choose its **Prepare** button in that window. Chrome may download several gigabytes and requires supported hardware and sufficient storage. Spoilt does not start a model download during ordinary page scans.
4. Wait for a successful local readiness check. Creating a session or finding an installed model alone does not mean inference has been verified.
5. Keep the analysis window open while browsing. Optionally select **Minimize this window after successful setup**. Spoilt minimizes only its own dedicated window after a readiness prompt succeeds. Closing it returns future semantic checks to direct matching; choose Prepare again to reopen it. Existing static pages retry analysis after the window connects and after a readiness check succeeds.

Text and image models have separate capability checks and preparation buttons. Settings changes and returning to the window refresh eligibility without initiating a download. If Chrome reports a model unavailable, keyword and description protection continues. Consult [Chrome's requirements](https://developer.chrome.com/docs/ai/get-started#requirements). A minimized window is still a live Chrome window; Chrome can pause it under memory pressure, so restore it to check its status if analysis stops.

## Execution and privacy

The [Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api) describes Window-based support; the API is not supported in Web Workers. Content scripts also cannot be assumed to expose the native API. Spoilt therefore runs native inference in its own top-level extension analysis window, using the standard [Chrome Windows API](https://developer.chrome.com/docs/extensions/reference/api/windows). This design adds no extension permissions, host scope, remote code, or cloud inference. It does not use an offscreen document or relax browser security settings. Window creation, restoration and optional minimization follow explicit user actions; background scans and reconnects do not change focus.

Content scripts send bounded classification inputs through the background worker to an authenticated connection from the exact packaged analysis page. The host loads boundary settings and recent knowledge from extension storage; callers cannot supply arbitrary prompts or settings. Text requests contain at most 18 snippets of 600 characters each. Image requests contain at most 1.5 MB of raster image bytes and 1,000 characters of metadata. Replies are checked for valid decision shapes and indices.

Requests are limited to eight outstanding operations overall and two per source document. The host prefers viewport work from Chrome's active tab, while admitting older lower-priority work after four preferred dispatches or one second of waiting. Queued requests wait at most four seconds before returning a busy result; the 20-second model execution deadline begins at dispatch. A running request can still occupy the entire queue-wait budget, in which case clients use bounded retries. The broker retains its 25-second overall limit. Speculative link analysis yields to live work and is cancelled when foreground work arrives. Navigation, settings or recent-knowledge changes, explicit resets, and disconnection cancel or invalidate work. An idle host reconnects with a bounded retry delay after a worker disconnect.

Text and image analysis each retain at most one pristine baseline session containing fixed instructions, boundaries and recent public context. Each classification uses an independent disposable clone; page text, image inputs and model replies never enter the baseline. Clones are destroyed after each operation, including cancellation and late creation. Baselines expire after 60 seconds of idle time and are destroyed on configuration changes or window closure. Browsers without session cloning use disposable sessions instead. This follows Chrome's [session management guidance](https://developer.chrome.com/docs/ai/session-management).

When capacity is busy, clients retry with finite delayed backoff and retain unfinished text/image candidates. The page can perform three additional coalesced rescans; completed decisions are not resent. Pause, navigation and settings changes cancel retry work. Continued overload eventually stops automatic retrying and leaves unfinished candidates eligible for a later scan; this is bounded recovery rather than a FIFO or unlimited-throughput guarantee. Readable canvas pixels share the image pipeline's maximum side of 1,024 pixels and 1.5 MB encoded-byte limit; tainted or unreadable pixels fall back safely.

Candidate scheduling gives viewport content the first batches and continues below the fold. Identical snippets share a request and matching decisions are applied to every unchanged occurrence. A separate document-local text cache holds at most 700 exact snippets for 60 seconds, including safe decisions; it is invalidated by route, settings or recent-knowledge changes. Text longer than a complete model snippet is not admitted as a cached decision. Image checks continue alongside text work rather than waiting for all text batches to finish.

Raw inputs remain transient. This change does not add a prompt history or image cache. The existing bounded positive-decision cache still applies, as described in [Privacy](../PRIVACY.md). An operational retry nonce contains no page content or URLs. **Local performance details** in the analysis window retains up to 128 numeric timing samples and fixed outcome labels in memory. It records queue wait, session creation/cloning, inference duration and input/output sizes, without text, images, URLs or boundary values. Closing the window clears these diagnostics.

## Verification

Unit tests cover message authorization, input/output bounds, cancellation, unavailable/download states, readiness prompts, and retrying static pages after setup. Browser tests inject their synthetic model into the extension analysis page and exercise the real internal routing. These tests establish extension behavior; they do not prove native model availability or accuracy on a particular device.

A native smoke test must use an already-available model and complete an actual prompt before reporting native inference as working. An unavailable result remains a release limitation until a supported profile passes that check.

`npm run test:performance` exercises the production extension with a synthetic model in a temporary browser profile. Its request counts and timings establish orchestration behavior, not native GPU throughput or model accuracy. Native cold/warm timings and semantic accuracy must be evaluated separately before claiming a measured device speedup.
