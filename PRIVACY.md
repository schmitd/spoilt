# Privacy

Spoilt is designed to process browsed content locally.

## Data Stored

- Boundary settings are stored in Chrome sync storage so Chrome may synchronize them between browsers signed into the same profile.
- Operational status, concealment counters, and optional recent-spoiler knowledge are stored in Chrome local storage.
- Spoilt does not operate a remote backend and does not sell or share user data.

## Page Content

Spoilt reads visible page text and image metadata so it can apply the boundaries configured by the user. This content is processed inside the browser. When Chrome's on-device Prompt API is available, semantic analysis also remains on the device.

For image analysis, Spoilt may fetch the selected image into the extension process. The image is passed only to Chrome's on-device model and is not uploaded by Spoilt.

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
