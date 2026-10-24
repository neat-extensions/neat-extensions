# Extension Factory

## Opening links for the owner

Any URL the owner must open (sign-in, OAuth consent, wrangler/gh/gcloud login, dashboards) is opened with `npm run open -- <url>` from the Extension Factory repo (or Start-Process chrome.exe --profile-directory=<channel profile> <url> elsewhere) — never the default profile. The channel/business Google account is arcan2252@gmail.com.

`npm run open -- --which` prints the channel profile directory (found by its primary account in Chrome's Local State; override with `CHANNEL_PROFILE`).

## Running the Neat Record e2e tests on this PC

Windows Smart App Control is on and blocks Playwright's unsigned Chromium (`spawn UNKNOWN`). Run the browser tests in Edge instead: `E2E_CHANNEL=msedge npx playwright test --project=record-e2e`. Branded Chrome ignores `--load-extension`, so it can't be used.

## Release rule: two independent verifications (owner's standing rule)

Every release (any product, any version) gets two independent verifications before it ships:

1. **The builder's own test suite** — lint, unit and e2e (`npm run release` / `release:ship` for YouTube, `npm run build -- record --release` plus `E2E_CHANNEL=msedge npx playwright test` for Record).
2. **A fresh black-box checker agent** that receives ONLY the built package (the release zip or its unpacked folder), the public help page and the Free/Pro feature list — never the source, the test code, or the first verification's result. It installs the package in Edge and exercises every user-facing feature end to end, as a user would.

A release ships (upload for review, submit, or publish) only when both agree. Any disagreement is investigated and resolved before shipping, never waved through.
