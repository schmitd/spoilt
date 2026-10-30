# Privacy

Spoilt is designed to process browsed content locally.

## Data Stored

- Boundary settings are stored in Chrome sync storage so Chrome may synchronize them between browsers signed into the same profile.
- Operational status, concealment counters, and optional recent-spoiler knowledge are stored in Chrome local storage.
- Spoilt does not operate a remote backend and does not sell or share user data.

## Page Content

Spoilt reads visible page text and image metadata so it can apply the boundaries configured by the user. This content is processed inside the browser. When Chrome's on-device Prompt API is available, semantic analysis also remains on the device.

For image analysis, Spoilt may fetch the selected image into the extension process. The image is passed only to Chrome's on-device model and is not uploaded by Spoilt.

Native analysis runs in Spoilt's compact extension window, which must remain open while browsing and may be minimized after successful setup if you choose. Closing it stops future native checks; keyword and description matching remain active. Ordinary scans use only models Chrome reports as already available. Model preparation requires an explicit button click after a download disclosure; Chrome may download several gigabytes. Classification inputs stay in memory during bounded requests. Each operation uses a disposable session or independent clone, destroyed after completion or cancellation. A pristine baseline for text and another for images may retain fixed instructions, boundaries and recent public context until 60 seconds of idle time, configuration changes or window closure; baselines never receive browsed page inputs or replies. An operational retry nonce contains no page content or URLs. Existing positive-decision retention is described below.

The analysis window's optional local performance details retain at most 128 numeric timing samples and fixed labels in memory. These include request counts, text lengths, output lengths and session/inference durations. They contain no page text, images, URLs, boundary values or model replies and are not uploaded or written to storage. Closing the window clears them.

## Optional Recent Knowledge

When **Keep recent knowledge up to date** is enabled, Spoilt sends search queries derived from enabled boundary names, descriptions, and keywords to Google News RSS. It stores a limited set of returned headlines, links, source names, dates, and image references locally.

This feature can be disabled or its stored data cleared from the settings page.

## Permissions

- `storage`: saves settings, status, and optional recent knowledge.
- `alarms`: schedules optional recent-knowledge refreshes.
- `activeTab`: lets the popup request an immediate check of the current page.
- `<all_urls>`: runs protection on browsed pages and permits image retrieval for local analysis.

## Retention and Control

Uninstalling the extension removes Chrome local storage. Chrome sync data is managed by Chrome and the user's Google account. Users can disable protection, remove individual boundaries, disable recent knowledge, clear its stored data, or reset settings at any time.

## Optional Link Prefetching

**Prefetch likely links** is off by default. When enabled, hovering or focusing an
eligible same-origin link sends a GET request before you click, including normal
site cookies. This can reveal interest in a page to that site, consume extra data,
and register a page view. Common action URLs are excluded, but a site can attach
side effects to any GET URL; these cannot be detected reliably from a link alone.
Fetched HTML is read without executing it and may enter Chrome's normal HTTP cache,
subject to the site's caching rules. Spoilt checks static text from a prefetched
page against your rules before navigation. If on-device analysis is enabled, it
may also analyze text and up to three same-origin images. CDN image descriptions
and URLs can be checked locally without downloading their pixels for analysis.
Positive decisions, the matching text or image URL, the destination URL, and the
rule context are
held in Chrome session storage and scoped to the source tab and tabs opened
from it for the same destination. Decisions expire after 60 seconds and are scheduled for removal; the underlying image bytes are not stored
there. Session data is cleared when Chrome exits. `no-store` responses are not pre-analyzed. Turn the setting or protection
off to stop prefetching.

## Live Decision Reuse

Positive decisions made by on-device analysis on the current page are retained in
content-script memory so hydration can replace DOM nodes without exposing known
matches again. Up to 700 exact text fragments and 300 image-source decisions, the
exact page URL, and the rule context are also held in trusted Chrome session
storage for up to 60 seconds to protect same-tab reloads. Query strings and hashes
are part of this identity. These entries are scheduled for removal, cleared on
browser exit and tab closure, and ignored after settings or recent knowledge
change. A route change discards the active in-memory decisions. This happens
independently of the optional link-prefetch setting, requires no new permissions,
and sends no content to a server. Image bytes are not retained in this cache.

A document-local inference cache additionally holds at most 700 exact text snippets
and their positive or safe decisions for up to 60 seconds to avoid rechecking
duplicate or replaced nodes. This cache stays in content-script memory, is not
written to Chrome storage, and is discarded on route, settings or recent-knowledge
changes. It is not shared between pages or tabs. Long text whose full contents do
not fit in a model snippet is not cached as a complete decision.
