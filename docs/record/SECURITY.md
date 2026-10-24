# Neat Record — security and threat model

Neat Record records a tab, a window, the whole screen or a drawn box, and saves
the video to the user's Downloads folder. Pro adds a Share-to-Google-Drive link.
This page says what it can touch, what could go wrong, and what stops it.

## What the extension can do (and nothing else)

| Capability | Why | Limit |
|---|---|---|
| `tabCapture` | record the tab the user is on | only after a click on the icon or the shortcut (Chrome's activeTab rule) |
| `getDisplayMedia` (no permission) | record a window or the screen | Chrome's own picker; the user chooses, Chrome shows its sharing bar |
| `activeTab` + `scripting` | show the box overlay, the recording bar and the saved card on that tab | one bundled file (`content.js`) via `executeScript({files})`; the build refuses `func`, `code`, CSS strings and registered content scripts |
| `offscreen` | the recorder (a service worker can't record) | exists only while recording or running a Pro job; closed afterwards |
| `downloads` | save the video | files are made by the extension; no reading of the user's downloads |
| `storage` | settings; the licence key (sync) | no browsing data, no video data |
| `identity` + `drive.file` scope | Share (Pro) | only after the user presses Share; `drive.file` lets the extension see **only files it created**; Google lists it as non-sensitive |
| one web-accessible page (`camera.html`) | webcam bubble (Pro) inside the recorded page | loaded with `use_dynamic_url`, so pages can't probe for it; it shows the camera and nothing else; no other extension page can be framed by a website |

No host permissions. No content scripts in the manifest. No remote code. No
analytics, no third-party scripts, no server of ours in the recording path.

## Network

The extension pages' CSP is:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:;
connect-src https://www.googleapis.com; object-src 'none'; base-uri 'none'; form-action 'none'
```

(No `frame-ancestors`: the webcam bubble has to be framed by the recorded page.
Web pages can only frame web-accessible files, and that is `camera.html` alone.)

`googleapis.com` is reached only by Share. `media-src blob:` exists so the
recorder can read its own saved file back to make a GIF. The build
(`scripts/build-tool.mjs` + `scripts/policy.mjs`) fails if any of this widens,
if any permission is added, if shipped code mentions an unexpected host, or if
it contains `eval`, `Function(`, HTML-injection sinks, `setInterval`, remote
imports or test settings.

## Assets and threats

**The user's screen and videos.** A recording starts only from a user action
(click, or the Pro shortcut). Chrome shows its own "sharing this tab/screen"
indicator; the toolbar badge says REC. Video data lives in the extension's
private origin storage (OPFS) while being written — through a sync access
handle, flushed every few seconds, so a crash keeps it — and is deleted after
saving. Pro keeps the last file until the saved card is closed, a new
recording starts or Chrome restarts (for Share/Trim/GIF). A recording cut off
by a crash is repaired and saved to Downloads at the next start, then deleted.
It is never sent anywhere unless the user presses Share.

**A hostile web page** (the page being recorded). The in-page UI is in a
*closed* shadow root, so page scripts can't read the share link or the
controls, and every handler ignores synthetic events (`isTrusted`), so a page
can't press our buttons, cancel or choose a box, or paint fake click
highlights. The content script reads nothing from the page and accepts no
messages from it (only `chrome.runtime` messages from the extension). The copy
step only writes a `https://drive.google.com/` link. A page could hide or cover
the bar — the panel (toolbar icon) always has Stop. A page cannot start a
recording: that needs the user's click.

**A compromised page renderer** (worst case: an attacker controls the
process the content script runs in). The service worker accepts from content
scripts only the messages a user's button can send (stop, pause, trim, share
of the user's own recording…). Recorder messages (`rec:*`, `drive:*`,
progress) are accepted only from the offscreen document's URL with no tab,
and the recorder accepts commands only from the service worker's URL — so a
page can't ask for the Drive token, fake a finished recording, or make the
extension download an arbitrary URL (downloads must be the recorder's own
`blob:chrome-extension://<id>/` URLs).

**A page trying to use the webcam bubble.** `camera.html` takes no input, sends
nothing, and its URL changes per session (`use_dynamic_url`).

**Messages.** The service worker ignores messages from other extensions
(`sender.id`), checks who each message type may come from (above), validates
the fields it uses (box and viewport are finite numbers inside the page, trim
ranges are ordered, Drive folder ids match a strict pattern, download URLs are
the recorder's own blobs), tags every recording with an id so a late result
from an earlier one is ignored, and handles state changes in one queue.

**Licence keys.** ECDSA P-256 signatures verified offline against a public key
in the extension. A forged, tampered, wrong-product, old-format or revoked key
is refused (unit-tested). A key's subject id is random — nothing in it says who
bought it. Refunded or publicly leaked keys are switched off by adding their
subject id to `revokedLicences` in the next release. The private key is only on
the owner's machine and in the Worker's secret store. Someone patching their
own copy to skip the check gains Pro features on their own machine — accepted;
nothing server-side is exposed.

**Google account.** OAuth via `chrome.identity.getAuthToken` (Chrome holds the
token). Scope `drive.file` only. A revoked/expired token is dropped and asked
for again once; a second refusal ends with a plain message.

**Payment.** Stripe-hosted checkout; the extension and the Worker never see card
data. The Worker re-checks each Checkout Session with Stripe (status `complete`,
`paid` or `no_payment_required`, our price id) before signing; keys are stored
per session in KV so a refresh returns the same key and the email goes out once
(KV is eventually consistent: two near-simultaneous first visits from far-apart
locations could mint two valid keys for one purchase — harmless). The buyer's
email is deleted from KV once the key email has been sent; the page shows it
masked. Unknown or unpaid session ids are cached for 10 minutes so random-id
scripts can't become one Stripe call each; the owner adds a Cloudflare rate
limit on `/success` as well. The Worker refuses to run with placeholder
settings. Its pages send `Cache-Control: no-store`, `Referrer-Policy:
no-referrer`, a hash-locked CSP and `noindex`. Its Stripe key is a
*restricted* key with read access to Checkout Sessions only.

**Supply chain.** The extension has no runtime dependencies: everything shipped
is this repository's code, bundled by esbuild. Dev dependencies (Playwright,
esbuild, ESLint, fflate) never ship. `npm audit` is run before each release.

## Lightness

Zero background work when idle: no alarms, no timers, no listeners on pages
(the page UI is injected only on click), the service worker sleeps, the
offscreen recorder is closed after saving. Bundle gate: 400 KB.

## Reporting a problem

Open an issue at https://github.com/neat-extensions/neat-extensions/issues
(mark it "security" and leave out details until we reply, if it's sensitive).
