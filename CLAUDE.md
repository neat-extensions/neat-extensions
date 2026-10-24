# Extension Factory

## Opening links for the owner

Any URL the owner must open (sign-in, OAuth consent, wrangler/gh/gcloud login, dashboards) is opened with `npm run open -- <url>` from the Extension Factory repo (or Start-Process chrome.exe --profile-directory=<channel profile> <url> elsewhere) — never the default profile. The channel/business Google account is arcan2252@gmail.com.

`npm run open -- --which` prints the channel profile directory (found by its primary account in Chrome's Local State; override with `CHANNEL_PROFILE`).

## Running the Neat Record e2e tests on this PC

Windows Smart App Control is on and blocks Playwright's unsigned Chromium (`spawn UNKNOWN`). Run the browser tests in Edge instead: `E2E_CHANNEL=msedge npx playwright test --project=record-e2e`. Branded Chrome ignores `--load-extension`, so it can't be used.
