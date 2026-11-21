# Chrome Web Store submission

This is a submission worksheet, not evidence that the extension has been accepted
or published. Bind the uploaded ZIP to its source commit and release receipt.

## Listing

- Name: **Spoilt**
- Summary: **Create healthy boundaries around spoilers and unwanted content.**
- Suggested category: **Productivity**; choose the matching current dashboard category.
- Language: **English**
- Privacy policy: <https://github.com/schmitd/spoilt/blob/main/PRIVACY.md>
- Support: <https://github.com/schmitd/spoilt/issues>
- Source/homepage: <https://github.com/schmitd/spoilt>

### Detailed description

Browse with boundaries you choose. Spoilt conceals text and images that match
your configured subjects, using a whiteout or marker treatment.

Create boundaries with descriptions and explicit keywords. Give each one a name
to keep it organized; names are labels and do not become matching keywords.
Pause protection when you need to, and adjust how strictly subjects are matched.

On supported devices and Chrome profiles, optional on-device analysis compares
meaning and can examine image pixels. Chrome runs this analysis locally. Open
Spoilt's analysis window, complete its readiness check, and keep that window open
while browsing; it can be minimized after setup. Chrome may require a model
download of several gigabytes after you choose Prepare. Model availability and
performance depend on Chrome, the device and the profile. Keyword and description
matching remain available when native analysis is unavailable.

Recent spoiler knowledge retrieves public headlines from Google News using your
boundary descriptions and keywords. It is enabled by default and can be turned
off in settings. Browsed page content is excluded from those queries. Optional
link prefetching is off by default; enabling it can request a linked page before
you click.

Spoilt has no developer-operated backend and does not sell user data. Page
analysis stays in the browser. Chrome may sync boundary settings through your
Google account; local and short-lived session caches support protection across
page updates. Read the privacy policy for provider requests, data retention and
controls.

Protection is best effort. Newly loaded content may appear before analysis, and
matching can miss content or conceal something you wanted to see. Spoilt does not
guarantee that all spoilers or unwanted subjects will be hidden.

## Privacy practices worksheet

Single purpose:

> Conceal browsed text and images that match the user's configured content
> boundaries, with direct matching and supported on-device analysis.

Permission justifications:

| Permission | Justification |
| --- | --- |
| `storage` | Save configured boundaries and preferences in Chrome sync storage; keep operational status, optional recent knowledge and bounded positive decisions in local/session storage. |
| `alarms` | Schedule recent-knowledge refreshes when that feature is enabled and removal of expired prepared decisions. |
| `<all_urls>` | Apply the same configured protection to ordinary websites the user visits. Read page text/image metadata, retrieve selected image pixels for local analysis, request optional Google News RSS, and support explicitly enabled link prefetching. Restricted Chrome pages remain outside content-script access. |

The popup requests a check of the focused page by messaging the already-injected
content script by tab ID. No temporary host permission is requested for this
manual check.

Remote code: **No**. Executable JavaScript and styles are packaged. Fetched RSS,
images and HTML are data, and fetched HTML is not executed. Chrome-managed local
model weights are not remote hosted executable code under Chrome's AI guidance.

Disclose local processing as well as external requests. The implementation handles
website content, current/destination URLs and optional hover/focus-triggered
prefetch activity. Use the current dashboard definitions to declare **Website
content**, **Web history**, and **User activity** for these paths; do not select
"no user data" merely because Spoilt has no backend. Settings may contain
user-entered subjects; arbitrary website content can also contain sensitive data.
Check the actual form's remaining category definitions before certifying them.

Certifications must match `PRIVACY.md`: no sale/data-broker transfers, no
advertising use, no credit/lending use, and use only for the extension's single
purpose. The public policy includes the Limited Use statement.

## Reviewer instructions

1. Add a boundary with a harmless explicit keyword, such as `fictional-crown`.
   Visit a controlled page containing that exact text and unrelated gardening
   prose. Confirm the matching text is concealed, the control remains visible,
   and disabling protection restores the text.
2. Rename that boundary without changing its description or keywords. Matching
   should stay the same, while concealment labels update.
3. For native analysis, use an eligible Chrome profile with an already-available
   model. Open **Prepare on-device analysis** from Spoilt, run the local readiness
   check, and keep its analysis window open. Spoilt's explicit model preparation
   uses a separate Prepare action; Chrome may independently manage or download
   models. A model is not necessary to test direct matching.
4. Follow [native acceptance](NATIVE-ACCEPTANCE.md) for a semantic-only positive
   and safe control, actual inference evidence, and timing interpretation. Test
   image availability independently. Do not treat a direct keyword/description
   match as proof of semantic analysis.
5. Verify that unavailable native analysis leaves direct protection working.

No Spoilt account, payment or remote inference key is required to use the
extension. Device/profile eligibility still applies to Chrome's model.

## Submission and publication evidence

- Run `npm run test:release` and record the final source commit, ZIP hash, 340
  unit/component tests (or the current total), manifest test, browser suites and
  audit result. Run the separate native acceptance where available.
- Provide the 128px PNG icon and 1–5 accurate 1280x800 screenshots of the final
  build. Promotional tiles are optional. Never use private browsing screenshots.
- CI saves an allowlisted `spoilt-store-candidate-<commit>` artifact after the
  release gate, with the extension ZIP, public screenshots, worksheet and package
  identity. Retrieve it through authorized GitHub access when publishing from a
  different computer. Verify the identity, then upload only the inner extension
  ZIP; the outer documentation/artifact archive is not a valid Store package.
- Verify the privacy/support URLs without signing in after merging policy edits.
- Select the actual intended publisher account/group in the dashboard. Preserve
  existing registration and payment; do not register/pay again.
- Inspect existing uploads before choosing a version. Each subsequent upload
  requires a higher version; bump package/config versions together and rerun the
  release gate if the dashboard already contains this version.
- Enter only publisher-approved contact details and its declared Trader or
  Non-Trader status. Do not infer that declaration from its name or free pricing.
- Review the listing, data practices and distribution. Submit the exact verified
  ZIP only after acceptance and account requirements are satisfied. Record the
  item ID, uploaded version/hash, submission status and review receipt.
- Submission for review and public release are separate states. Verify the live
  item URL and published version before reporting it as launched.

Official references, checked November 17, 2026:
[listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing),
[images](https://developer.chrome.com/docs/webstore/images),
[privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy),
[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
[trader verification](https://developer.chrome.com/docs/webstore/program-policies/trader-verification-faq),
[account setup](https://developer.chrome.com/docs/webstore/set-up-account),
[AI in extensions](https://developer.chrome.com/docs/extensions/ai).
