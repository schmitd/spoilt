# Store assets

These images show the production extension with synthetic local content and a
fictional boundary, captured November 17, 2026 in an isolated test profile.
They contain no private browsing content, account details or native-model mocks.

Upload screenshots:

1. `01-keyword-protection-1280x800.png`: actual direct matching conceals three text
   fragments and one image in a fictional feed. Safe content stays visible.
2. `02-boundary-settings-1280x800.png`: actual boundary editor and Google News
   query disclosure, at a normal scroll position.

Both screenshots are 1280x800 RGB PNGs. `extension-icon-128.png` is the exact
existing 128px icon. `small-promo-440x280.png` is an optional promotional tile.

The captures used explicit keyword matching with native analysis, recent
knowledge and link prefetching disabled in the temporary profile. No AI inference
or device-speed claim is represented by these screenshots. UI text/styles were
not replaced for the capture.

After the full release gate, CI records package and individual build-file hashes
in `.output/store-package-identity.json` and uploads an allowlisted Store-candidate
artifact. Download it through authorized GitHub access and verify its source/run
and ZIP hash before uploading only the inner `spoilt-<version>-chrome.zip` to the
Store. The outer artifact contains documentation and is not an extension package.

Native acceptance, publisher/contact declarations and Store review are separate
requirements. An artifact upload does not mean Spoilt has launched.
