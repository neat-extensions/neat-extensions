# Extension Factory

## Opening links for the owner

Any URL the owner must open (sign-in, OAuth consent, wrangler/gh/gcloud login, dashboards) is opened with `npm run open -- <url>` from the Extension Factory repo (or Start-Process chrome.exe --profile-directory=<channel profile> <url> elsewhere) — never the default profile. The channel/business Google account is arcan2252@gmail.com.

`npm run open -- --which` prints the channel profile directory (found by its primary account in Chrome's Local State; override with `CHANNEL_PROFILE`).
