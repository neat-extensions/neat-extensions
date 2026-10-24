# Extension Factory

A small factory for privacy-first Chrome extensions (Manifest V3).
Product 1 is **Neat for YouTube** — listed as "Neat — Hide YouTube Shorts" (a
*rules* product). Product 2 is **Neat Record** — "Neat Record — Screen Recorder,
Draw a Box" (a *tool* product: no remote rules, no updater). See
[Neat Record](#neat-record-product-2) below.

The brand name is a placeholder. It lives in exactly one place:

```js
// brand.config.js
export const BRAND = "Neat";
```

Change that line and every manifest, page, store text, attribute name and zip
name follows on the next build.

## Layout

```
brand.config.js            the one brand constant
packages/engine/           shared engine — knows nothing about any site
  src/schema.js            strict rules validator (+ rules-URL check)
  src/version.js           semver compare
  src/locators.js          css / text / structural locators
  src/css.js               builds the single injected stylesheet
  src/selfcheck.js         "are the targets really hidden?" check
  src/updater.js           remote rules fetch → verify signature → validate → keep last good
  src/signature.js         ECDSA P-256 verification of rules files (WebCrypto)
  src/settings.js          storage layout, defaults, rule picking
  src/content.js           content-script runtime (stylesheet + observer)
  src/background.js        MV3 service worker (alarms, commands, messages)
  ui/                      popup + options pages (vanilla JS, light/dark)
apps/youtube/              product 1 = engine + rules + small site config
  site.config.js           ids, URLs, signing key, features, self-check probes, page/channel detection
  rules/rules.json         bundled rules (fallback when remote is unavailable)
  src/features.js          non-hiding behaviours: Shorts redirect, autoplay off
  src/*.js                 2-line entry points wiring engine + config
  listing.js               store copy (title, summary, description)
  assets/icon.svg          source icon → icons/*.png (npm run icons)
scripts/
  build.mjs                lint → unit tests → bundle → policy checks → zip
  policy.mjs               allowed permissions, manifest/CSP rules, size budget, source scan
  rules-key.mjs            generate the rules signing key; sign a rules file
  publish-rules.mjs        npm run rules:publish — sign rules → docs/ (GitHub Pages) → commit → push
  check-remote-rules.mjs   canary check of the deployed (signed) rules file
  cws.mjs                  Chrome Web Store API v2: auth / status / upload / publish (--publish only)
  ship.mjs                 npm run release:ship — release pipeline → upload → status [→ --publish]
  store.mjs                generates store/ (texts, privacy, landing, screenshots)
  icons.mjs                renders the SVG icon to 16/32/48/128 PNGs
tools/finder/              niche finder: store search → listings → scored report (npm run finder)
finder/                    queries.txt, report-<date>.md
tests/
  unit/                    validator, versions, updater, self-check (fixture HTML), policy, site config
  e2e/                     live YouTube with the unpacked extension loaded
  fixtures/                HTML fixtures for the self-check tests
  canary-reporter.js       writes test-results/canary-summary.json for the canary issue
.github/workflows/canary.yml   daily 06:00 UTC + on push; opens "CANARY BROKEN: …" issues
store/                     generated store kit (see below)
docs/                      GitHub Pages: youtube/rules.json(.sig), landing page, privacy policy (generated)
dist/                      build output: dist/youtube/ (unpacked) + dist/neat-youtube-<v>.zip
```

## Commands

```bash
npm ci
npx playwright install chromium
npm run build          # lint + unit tests + bundle + policy checks + zip
npm run release        # the above + refuses placeholders (rules URL / signing key), then live e2e; zip removed if e2e fails
npm run test:unit
npm run test:e2e       # live YouTube; needs network
npm run store          # regenerate store/ including live screenshots
npm run icons
npm run rules:publish  # sign + publish rules (and landing/privacy) to GitHub Pages
npm run rules:check    # verify the live rules file (needs RULES_URL, RULES_PUBLIC_KEY)
```

The build fails if any manifest permission is outside `storage` + `alarms` +
`https://www.youtube.com/*`, if the manifest has unexpected keys or a weak CSP,
if the unpacked bundle is over 300 KB, if lint or any unit test fails, or if
shipped JS contains `eval`, `Function(`, `innerHTML`-style sinks, script
creation, `setInterval`, remote imports or an unexpected URL. A plain build
with the placeholder rules URL prints a warning (remote rules off); `--release`
turns that into a failure.

## How the engine works

* **Rules are data, never code.** A rules file has `version`, `site`,
  `minEngineVersion` and `rules[]`; each rule has `id`, `label`, `default`,
  `group` and 1–3 `locators`, tried in order:
  * `{"type":"css","selector":"…"}` — hidden directly by the stylesheet;
  * `{"type":"text","container":"…","label":"…","match":"Shorts"}` — the
    nearest container holding a label whose text equals `match`;
  * `{"type":"structural","anchor":"…","container":"…"}` — from an anchor
    element, climb to its nearest container.

  The validator rejects any key outside the schema, any selector containing
  `{ } ; @ \ <`, comments, `url()`/`image-set()`/…, selectors that target the
  whole page (`html`, `body`, `:root`, `ytd-app`, `*`, bare `:not(…)`), more
  than three `:has()`, and any string that looks like code (`=>`, `function`,
  `eval`, `javascript:`, `${`, `document.x`, …). Remote rules may change
  locators and add rules but can never re-label a shipped rule or flip its
  default.
* **Hiding** is one `<style>` element injected at `document_start` holding only
  `display: none !important` rules. Text/structural matches get a marker
  attribute the same stylesheet hides. Toggling = rewriting that stylesheet:
  instant, no reload.
* **Observer**: one `MutationObserver` (childList only). Added nodes are batched
  to at most one pass per animation frame and only the changed subtrees are
  scanned — new targets are marked, and nodes YouTube recycled for other
  content are unmarked. No polling, no timers in the page; when the page is
  quiet, the engine does nothing.
* **Self-check** (in idle time, at most every 3 s, never in hidden tabs): for
  every enabled rule, count visible elements (rendered, not hidden by CSS,
  non-zero box) found by the rule's locators **and** by the site's
  independent probes (`site.config.js → probes`, e.g. "any visible link to
  /shorts/ in search results"). The probes are what catch real markup drift:
  when YouTube renames elements, the locators match nothing but the probe
  still sees Shorts. Any → re-mark and recheck → still visible → ask the
  service worker to re-fetch rules once → recheck → record a `broken` entry
  (rule id, YouTube client version, page type, time) in local storage. A
  primary selector that stopped matching while a fallback still works is
  recorded as `degraded`. Nothing is sent anywhere; it's shown under
  **Options → Diagnostics** with a Copy button.

## Adding a new site

1. `apps/<site>/rules/rules.json` — `"site": "<site>"`, your rules.
2. `apps/<site>/site.config.js` — copy the YouTube one: `id`, `matches`,
   `hostPermissions`, `rulesUrl`, `navigationEvents`, `groups`, `features`
   (may be empty), `probes` (one independent oracle per rule), `pageContext()`,
   `isAllowed()`, `normalizeChannel()`, `buildHint()`, `rulesPublicKey`.
3. `apps/<site>/src/{content,background,popup,options}.js` — copy the 2-line
   entry points; `features.js` only if the site needs non-hiding behaviour.
4. `apps/<site>/listing.js` and `apps/<site>/assets/icon.svg`, then
   `npm run icons -- <site>`.
5. Add the site's host to `ALLOWED_HOSTS` in `scripts/policy.mjs` (the policy
   is deliberately explicit per host), then `node scripts/build.mjs <site>`.
6. Copy `tests/e2e/youtube.spec.js` as a starting point for the site's canary.

## How rules updates ship without a store review

The service worker fetches `RULES_URL` and `RULES_URL.sig` on install/update,
on browser start-up and every 24 h (`chrome.alarms`), plus — still at most
hourly — when a tab's self-check reports a broken rule. A file is accepted
only if its **ECDSA P-256 signature verifies against the public key built into
the extension**, it is UTF-8 JSON under 64 KB, passes the strict schema, is for
the same `site`, needs no newer engine than the installed one, and has a
strictly higher `version`. Otherwise the last good rules stay in place (and
the bundled copy is always the floor).

### Publishing (GitHub Pages, `docs/` on `main`, served at neatextensions.com)

The rules host is GitHub Pages of this repository, published from the
`docs/` folder of `main`. `services/site-worker` (Cloudflare) serves the same
files at the brand domain:

| What | URL |
|---|---|
| rules | <https://neatextensions.com/youtube/rules.json> (+ `.sig`) |
| landing page | <https://neatextensions.com/> |
| privacy policy | <https://neatextensions.com/privacy.html> |
| Record help / Pro / privacy | <https://neatextensions.com/record/help.html>, `pro.html`, `privacy.html` |
| licence Worker | <https://licence.neatextensions.com> |
| email | keys@ and hello@neatextensions.com → Cloudflare Email Routing → the channel inbox |

The old address <https://neat-extensions.github.io/neat-extensions/> is not a
GitHub custom domain on purpose: YouTube builds up to 1.0.0 fetch their rules
there with `redirect: "error"`, so it must keep serving the files itself. Its
HTML pages carry a canonical link and send visitors on to neatextensions.com;
the rules files are served at both. Deploy the site Worker with
`cd services/site-worker && npx wrangler deploy` (only needed when it changes).

`docs/` is generated, never edited by hand. **To fix a YouTube breakage:**

1. edit `apps/youtube/rules/rules.json` and bump `version`;
2. `npm run test:unit` (and `npm run test:e2e` if you can);
3. `npm run rules:publish`.

`rules:publish` validates the rules, signs them with the private key
(`.secrets/rules-private.jwk`, or `RULES_PRIVATE_KEY_FILE`), checks the
signature against `site.config.js → rulesPublicKey`, writes
`docs/youtube/rules.json` + `.sig` and the landing/privacy pages from
`store/site/`, commits and pushes (git must be able to push without a prompt:
run `gh auth setup-git` once). An unchanged file is a no-op. It refuses changed rules with an unchanged
`version`. Pages goes live within about a minute; `npm run rules:check` (with
`RULES_URL` and `RULES_PUBLIC_KEY` set) fetches and verifies the live file,
and the canary does the same daily. `docs/*/rules.json` is `-text` in
`.gitattributes` so git never rewrites the signed bytes.

Every installed copy picks it up within a day — no store submission, because
rules are data (CSS selectors), not code. Changes to code, features or
permissions still need a normal store release.

The rules host must serve both files over HTTPS with
`Access-Control-Allow-Origin: *` (GitHub Pages does) and **without
redirects** (redirects are refused). The build sets the manifest CSP
`connect-src` to that one origin.

The rules URL and public key live in `apps/youtube/site.config.js`
(`rulesUrl`, `rulesPublicKey`); `RULES_URL` / `RULES_PUBLIC_KEY` override
them at build time. With the placeholder URL (`https://RULES_HOST/…`) or no
key, the extension never makes a network request at all (CSP `connect-src
'none'`) and `npm run release` refuses to build.

### Signing key

`npm run rules:key -- generate` writes `.secrets/rules-private.jwk`
(git-ignored) and prints the public key. The owner's backup copy is in
`%USERPROFILE%\Documents\Neat-keys\`. Losing the private key means no rules
update can ever be accepted by installed copies: generate a new key, put its
public half in `site.config.js`, and ship a store release.

## Store kit (`store/`)

`title.txt`, `summary.txt` (≤132 chars), `description.txt`, `listing.json`
(single purpose, permission justifications, data-use answers),
`privacy.html`, `site/` (one-page landing site + privacy page),
`screenshots/1-before-after.png`, `2-popup.png`, `3-options.png` (1280×800),
`promo-small-440x280.png`, `marquee-1400x560.png`.

## Testing notes

* E2E loads `dist-test/youtube` (built automatically by the `build-ext`
  setup project) into Playwright's Chromium (`channel: "chromium"`, new
  headless supports extensions), pre-sets YouTube's consent cookie (`SOCS`)
  and clicks "Reject all" if a consent dialog appears anyway.
* Oracles are independent of `rules.json`: they count what a user would see
  (visible links to `/shorts/`, a visible "Shorts" tab, …).
* A fresh logged-out profile gets an empty Home; the tests watch two videos
  first so Home has a real feed.
* From GitHub runners (datacenter IPs) YouTube sometimes serves Google's
  "unusual traffic" reCAPTCHA page or a "confirm you're not a bot" wall
  instead of the player. Tests that hit one are **skipped as blocked**, never
  reported as broken rules (and never solved). The canary run summary and a
  workflow warning list every blocked test, so a run that judged nothing is
  visible; the release e2e runs on the owner's machine, where it is not blocked.
* `tests/e2e/live-rules.spec.js` checks the shipped build against the live
  rules host: it loads the release zip (or `dist-test`), waits for the
  install-time fetch to verify the live signature, then tampers with the live
  `.sig` in transit and expects the file to be rejected.
* On Windows inside an app that virtualises `%LOCALAPPDATA%`, install browsers
  to a real folder: `PLAYWRIGHT_BROWSERS_PATH=.browsers npx playwright install chromium`
  and run tests with the same variable.

## Chrome Web Store API (`scripts/cws.mjs`)

After the first manual submission, releases go up without the dashboard form,
through the [Chrome Web Store API v2](https://developer.chrome.com/docs/webstore/using-api).

```bash
npm run cws:status  -- <itemId>            # review / publish state of the item
npm run cws:upload  -- <itemId> <zip>      # new package as a draft (does not publish)
npm run cws:publish -- <itemId> --publish  # submit for review; refuses without --publish
npm run release:ship                       # release pipeline → upload → status (draft only)
npm run release:ship -- --publish          # ...and submit for review
```

`release:ship` runs the whole release pipeline first (lint, unit, build,
policy, zip, live e2e) and uploads nothing if any step fails. It uses
`apps/<site>/site.config.js → storeItemId`.

**Credentials** live only in `.secrets/` (git-ignored), with the owner's backup
in `%USERPROFILE%\Documents\Neat-keys\`:

* `.secrets/cws-client.json` — `{ "client_id", "client_secret", "publisher_id" }`
  from a Google Cloud **Desktop app** OAuth client in project `neat-extensions`
  (Chrome Web Store API enabled), and the publisher id from the dashboard URL.
* `.secrets/cws-token.json` — the refresh token from the one-time
  `npm run cws -- auth`. It prints a consent URL, catches Google's redirect
  on `127.0.0.1` (PKCE + state), and stores the token. If the browser can't
  reach the local port, paste the final address-bar URL into
  `npm run cws -- auth --code "<url>"`.

While the OAuth consent screen is in **Testing**, Google expires refresh tokens
after 7 days: re-run `npm run cws -- auth` (or move the consent screen to
**In production**). The account needs 2-step verification to publish.

## Finder (`tools/finder/`)

Which extension niches have real demand and weak incumbents?

```bash
npm run finder                      # all phrases in finder/queries.txt
npm run finder -- --only "pdf merge"
```

For each phrase it fetches the public Chrome Web Store search page (no login),
then each of the top 10 listings' page, their reviews page (10 most recent)
and their declared permissions, read from the package's `manifest.json` via
Google's public update server. Packages are parsed in memory, never run;
anything over 25 MB is skipped. One request at a time per host, 2.5 s apart
with jitter, `Retry-After` honoured, Google's consent banner declined, pages
cached for 24 h in `finder/.cache/`. If the store blocks the run, listings fall
back to extscope.org (chrome-stats.com sits behind a bot challenge, which the
finder does not try to pass) and the report says so.

Scoring uses the top 5 listings per phrase (`tools/finder/score.mjs`):

* **demand** = sum of user counts, with each listing capped at 40% of the
  total, so a single giant can't make a niche look big;
* **weakness** = share rated under 4.2, OR not updated in 12 months, OR with
  "stopped working / doesn't work / broken" in the 10 latest reviews;
* **opportunity** = demand × weakness, 0 below 500 users.

Output: `finder/report-<date>.md`, committed. Each listing links to the page its
numbers came from. `finder/data-<date>.json` (git-ignored) holds the raw
extraction, with the exact page line behind every number. A number whose line
isn't found in the fetched page fails the run. Reviewer names are never kept.

## Neat Record (product 2)

A screen recorder: one click, no account, no watermark, the video never leaves
the computer (unless the user presses Share). Free: tab / window / screen /
draw-a-box, mic + sound, up to 1080p, unlimited recordings of up to 10 minutes
(at 10:00 it stops cleanly and saves). Pro ($9.99 once, offline licence key):
no limit, 1440p/4K, Share link to the user's own Google Drive, webcam bubble,
click highlights, 3-2-1 countdown, pause/resume, trim, GIF, keyboard shortcut.

```
apps/record/
  app.config.js        kind "tool": ids, pinned extension key + ID, OAuth client, licence public key, Payment Link
  listing.js           store copy
  src/background.js    service worker: start/stop, overlay injection, downloads, Pro jobs, shortcut (event-driven only)
  src/offscreen.js     the recorder: capture → crop/fixed size → MediaRecorder → OPFS → repair → blob: URL
  src/writer.js        worker writing chunks into OPFS through a sync access handle (survives crashes, full disks)
  src/content.js       in-page UI, injected on click: draw-a-box, bar, countdown, clicks, webcam bubble, saved card
  src/popup.js, pro.js, allow.js, camera.js   panel, Pro page (paste key), one-time mic/camera allow, webcam bubble
  src/lib/             crop maths, limiter, presets, WebM + MP4 repair/trim, GIF encoder, Drive client, tokens, icons
  ui/                  HTML/CSS (design tokens come from src/lib/tokens.js)
  store/               demo page + illustration used for screenshots
packages/engine/src/licence.js   offline licence keys (ECDSA P-256), shared by extension, scripts and Worker
services/licence-worker/         Cloudflare Worker: Stripe Checkout success → signed key → page + email
scripts/build-tool.mjs           tool-product build (same gates, RECORD_POLICY in policy.mjs)
scripts/store-record.mjs         store/record/ + docs/record/ (help, Pro poster, privacy), real screenshots
scripts/extension-key.mjs        pins an extension ID (manifest "key"); private half in .secrets/
scripts/licence-sign.mjs         generate the licence key pair; sign a key by hand
tests/unit/record-*.spec.js, licence-worker.spec.js
tests/e2e-record/                fake camera/mic/screen, local pages, fake Drive; no network needed
```

```bash
npm run build -- record             # lint + unit + bundle + policy + zip (+ dist/record/ unpacked)
npm run build -- record --release   # also refuses placeholders (OAuth client, Payment Link) and missing docs/record pages
npm run store -- record             # store/record/ kit + docs/record/ pages, screenshots from the real extension
npx playwright test --project=record-e2e
RECORD_LONG=1 npx playwright test --project=record-long   # 30-minute memory/CPU run (Windows)
```

**How it records.** The popup asks the service worker to start; the worker
injects the page UI (activeTab + `scripting.executeScript({files})`), gets a
tab stream id (`tabCapture.getMediaStreamId`) or lets Chrome's picker choose a
window/screen (`getDisplayMedia` in the offscreen document). Draw-a-box crops
each frame with `VideoFrame` `visibleRect` (zero-copy, bit-exact; measured
against canvas in `measure.spec.js`). Audio (tab/system + mic) is mixed with
Web Audio. MediaRecorder writes MP4 (H.264/AAC, level chosen from the real frame
size) when Chrome supports it, else WebM; each chunk goes straight into an OPFS
file through a sync access handle in a worker, flushed every few seconds, so
memory stays flat and a crash or full disk keeps what was recorded. On stop the
container is repaired — MediaRecorder output has no duration and no seek index
— *without copying*: `lib/mp4.js` (mvhd/tkhd/mdhd durations + mehd + mfra) and
`lib/webm.js` (known sizes, Duration, Cues) return the file as a list of new
header bytes and ranges of the raw file, which becomes a Blob of file slices
and is saved to Downloads with no dialog; then OPFS is cleared and the
offscreen document closed. If the repair fails, the raw file is saved as it is.
A recording cut off by a crash is repaired and saved at the next start
(`recover` in offscreen.js). Trim works the same way (whole keyframe fragments,
both ends within half a second).

**Zip names.** Only a build with the real OAuth client and Payment Link writes
`dist/neat-record-<v>.zip`; otherwise the zip is
`neat-record-<v>-not-for-upload.zip` (still fine for the first draft upload that
gets the store's item ID — owner steps D).

**Gates** (`RECORD_POLICY`): permissions exactly activeTab, downloads, identity,
offscreen, scripting, storage, tabCapture; no host permissions; no manifest
content scripts; one web-accessible page (`camera.html`, dynamic URL);
`connect-src https://www.googleapis.com` only; `drive.file` only; bundle
≤ 400 KB; `chrome.scripting` only with bundled files; no test settings in a
non-test build. Threat model: `docs/record/SECURITY.md`.

**Extension ID** is pinned by the manifest `key` (public half in
`app.config.js`; private `.secrets/record-extension-key.pem`, backup in
`%USERPROFILE%\Documents\Neat-keys\`): `njbhijplkhmcehhcemjofldcgpbgoopf`. The
unpacked build keeps the key; the store zip leaves it out (the store gives a new
item its own key on the first upload; owner steps D then put the store's
public key into `app.config.js`, so both builds share the store's ID).

**Licences.** `.secrets/licence-private.jwk` signs keys (Worker secret
`LICENCE_PRIVATE_JWK`); the public half is in `app.config.js`. Keys live in
`chrome.storage.sync`. "3 computers" is a licence term, not enforced.

**e2e notes.** Chromium's `--use-fake-ui-for-media-stream` breaks tab capture,
so tab/box tests launch with `--auto-accept-camera-and-microphone-capture` +
`--auto-accept-this-tab-capture` + `--allowlisted-extension-id`, and
window/screen tests with the fake UI. Playwright can't click the toolbar button
(which is what grants activeTab), so the `--test` build adds a host permission
for `127.0.0.1` only, uses `src/test-hook.js` as the worker entry, a throwaway
licence key pair, a 30× faster free limit, an open shadow root and a fake Drive
on `127.0.0.1:47123`. None of this can reach a normal or release build (the
build fails if it does).

Owner steps (Stripe, Cloudflare, OAuth client, trader, VAT):
`store/RECORD-OWNER-STEPS.md`. Upload checklist: `store/record/SUBMISSION.md`.

## Still owed by the owner (manual, one-time)

Done: GitHub repo (public), Actions with read/write permissions, repository
variables `RULES_URL` / `RULES_PUBLIC_KEY`, signing key, Pages hosting of the
rules + landing page + privacy policy, `sourceUrl`, Chrome Web Store listing
submitted (item `ojmhepcnbecbgcoehobgflnlfmebelkh`, publisher
`99b0b31c-95fb-47dc-8c7c-3c2dce181945`), Chrome Web Store API credentials
(Cloud project `neat-extensions`, `.secrets/cws-*.json`).

1. **After the store approves the item**, set `EXTENSION_ID` in
   `scripts/store.mjs` to `ojmhepcnbecbgcoehobgflnlfmebelkh` (until then the
   landing page shows a disabled "coming soon" button), then
   `npm run store -- --no-shots` and `npm run rules:publish`. (The
   in-extension review link uses the runtime id and needs no change.)
2. **Weekly while the OAuth consent screen is in Testing**: refresh tokens
   expire after 7 days, so run `npm run cws -- auth` before a release, or
   move the consent screen to "In production" once.
3. **Brand**: if "Neat" changes, edit `brand.config.js`, then `npm run build`,
   `npm run icons`, `npm run store`.
