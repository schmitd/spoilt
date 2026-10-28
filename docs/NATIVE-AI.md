# On-device analysis

Spoilt uses Chrome's built-in Prompt API for local semantic text and image classification. Keyword, description, and optional recent-knowledge matching remain available when the native model cannot run. A Chrome version alone does not establish model availability: hardware, disk space, profile eligibility, and Chrome's model state also matter.

## Setup

1. Enable **Use on-device analysis** in Manage boundaries. Image analysis is optional.
2. Open Spoilt's popup, expand **Protection details**, and choose **Prepare on-device analysis**. This opens or focuses Spoilt's analysis tab.
3. Read the download disclosure. If a model needs downloading, choose its **Prepare** button in that tab. Chrome may download several gigabytes and requires supported hardware and sufficient storage. Spoilt does not start a model download during ordinary page scans.
4. Wait for a successful local readiness check. Creating a session or finding an installed model alone does not mean inference has been verified.
5. Keep the analysis tab open while browsing. Existing static pages are asked to retry analysis after the tab connects and after a readiness check succeeds. Closing it returns future semantic checks to direct matching.

Text and image models have separate capability checks and preparation buttons. If Chrome reports a model unavailable, keyword and description protection continues. Consult [Chrome's requirements](https://developer.chrome.com/docs/ai/get-started#requirements), then reload the analysis tab after changing Chrome's model availability.

## Execution and privacy

The [Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api) describes Window-based support; the API is not supported in Web Workers. Content scripts also cannot be assumed to expose the native API. Spoilt therefore runs native inference in its own top-level extension analysis tab. This design adds no extension permissions, host scope, remote code, or cloud inference.

Content scripts send bounded classification inputs through the background worker to an authenticated connection from the exact packaged analysis page. The host loads boundary settings and recent knowledge from extension storage; callers cannot supply arbitrary prompts or settings. Text requests contain at most 18 snippets of 600 characters each. Image requests contain at most 1.5 MB of raster image bytes and 1,000 characters of metadata. Replies are checked for valid decision shapes and indices.

Requests are limited to eight outstanding operations overall and two per source document. The host cancels work after 20 seconds; the broker expires it after 25 seconds. Navigation, settings changes, explicit resets, and disconnection cancel or invalidate work. Sessions are destroyed after each operation, including cancellation and late session creation. An idle host reconnects with a bounded retry delay after a worker disconnect.

Raw inputs remain transient. This change does not add a prompt history or image cache. The existing bounded positive-decision cache still applies, as described in [Privacy](../PRIVACY.md). An operational retry nonce contains no page content or URLs.

## Verification

Unit tests cover message authorization, input/output bounds, cancellation, unavailable/download states, readiness prompts, and retrying static pages after setup. Browser tests inject their synthetic model into the extension analysis page and exercise the real internal routing. These tests establish extension behavior; they do not prove native model availability or accuracy on a particular device.

A native smoke test must use an already-available model and complete an actual prompt before reporting native inference as working. An unavailable result remains a release limitation until a supported profile passes that check.
