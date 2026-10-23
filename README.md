# Extension Factory

A small factory for privacy-first, rules-driven Chrome extensions (Manifest V3).
Product 1 is **Neat for YouTube** — listed as "Neat — Hide YouTube Shorts".

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
  src/updater.js           remote rules fetch → validate → keep last good
  src/settings.js          storage layout, defaults, rule picking
  src/content.js           content-script runtime (stylesheet + observer)
  src/background.js        MV3 service worker (alarms, commands, messages)
  ui/                      popup + options pages (vanilla JS, light/dark)
apps/youtube/              product 1 = engine + rules + small site config
  site.config.js           ids, URLs, features, page/channel detection
  rules/rules.json         bundled rules (fallback when remote is unavailable)
  src/features.js          non-hiding behaviours: Shorts redirect, autoplay off
  src/*.js                 2-line entry points wiring engine + config
  listing.js               store copy (title, summary, description)
  assets/icon.svg          source icon → icons/*.png (npm run icons)
scripts/
  build.mjs                lint → unit tests → bundle → policy checks → zip
  policy.mjs               allowed permissions, size budget, source scan
  store.mjs                generates store/ (texts, privacy, landing, screenshots)
  icons.mjs                renders the SVG icon to 16/32/48/128 PNGs
tests/
  unit/                    validator, versions, updater, self-check (fixture HTML), policy, site config
  e2e/                     live YouTube with the unpacked extension loaded
  fixtures/                HTML fixtures for the self-check tests
  canary-reporter.js       writes test-results/canary-summary.json for the canary issue
.github/workflows/canary.yml   daily 06:00 UTC + on push; opens "CANARY BROKEN: …" issues
store/                     generated store kit (see below)
dist/                      build output: dist/youtube/ (unpacked) + dist/neat-youtube-<v>.zip
```

## Commands

```bash
npm ci
npx playwright install chromium
npm run build          # lint + unit tests + bundle + policy checks + zip
npm run release        # the above, then the live e2e suite; zip removed if e2e fails
npm run test:unit
npm run test:e2e       # live YouTube; needs network
npm run store          # regenerate store/ including live screenshots
npm run icons
```

The build fails if any manifest permission is outside `storage` + `alarms` +
`https://www.youtube.com/*`, if the unpacked bundle is over 300 KB, if lint or
any unit test fails, or if shipped JS contains `eval`, `new Function`,
`innerHTML`-style sinks, `setInterval`, remote imports or an unexpected URL.

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
  `{ } ; @ \ <`, comments, `url()`/`image-set()`/…, and any string that looks
  like code (`=>`, `function`, `eval`, `javascript:`, `${`, `document.`, …).
* **Hiding** is one `<style>` element injected at `document_start` holding only
  `display: none !important` rules. Text/structural matches get a marker
  attribute the same stylesheet hides. Toggling = rewriting that stylesheet:
  instant, no reload.
* **Observer**: one `MutationObserver` (childList only). Added nodes are batched
  to at most one pass per animation frame and only the added subtrees are
  scanned. No polling, no timers in the page; when the page is quiet, the
  engine does nothing.
* **Self-check** (in idle time, at most every 3 s): for every enabled rule,
  count elements its locators match that are still visible (rendered, not
  hidden by CSS, non-zero box). Any → re-mark and recheck → still visible →
  ask the service worker to re-fetch rules once → recheck → record a
  `broken` entry (rule id, YouTube client version, page type, time) in local
  storage. A primary selector that stopped matching while a fallback still
  works is recorded as `degraded`. Nothing is sent anywhere; it's shown under
  **Options → Diagnostics** with a Copy button.

## Adding a new site

1. `apps/<site>/rules/rules.json` — `"site": "<site>"`, your rules.
2. `apps/<site>/site.config.js` — copy the YouTube one: `id`, `matches`,
   `hostPermissions`, `rulesUrl`, `navigationEvents`, `groups`, `features`
   (may be empty), `pageContext()`, `isAllowed()`, `normalizeChannel()`, `buildHint()`.
3. `apps/<site>/src/{content,background,popup,options}.js` — copy the 2-line
   entry points; `features.js` only if the site needs non-hiding behaviour.
4. `apps/<site>/listing.js` and `apps/<site>/assets/icon.svg`, then
   `npm run icons -- <site>`.
5. Add the site's host to `ALLOWED_HOSTS` in `scripts/policy.mjs` (the policy
   is deliberately explicit per host), then `node scripts/build.mjs <site>`.
6. Copy `tests/e2e/youtube.spec.js` as a starting point for the site's canary.

## How rules updates ship without a store review

The service worker fetches `RULES_URL` on install, on browser start-up and
every 24 h (`chrome.alarms`), plus at most every 10 minutes when a tab's
self-check reports a broken rule. A file is accepted only if it is valid JSON,
under 64 KB, passes the strict schema, is for the same `site`, needs no newer
engine than the installed one, and has a strictly higher `version`. Otherwise
the last good rules stay in place (and the bundled copy is always the floor).

To ship a fix: edit `apps/youtube/rules/rules.json`, bump `version`, run
`npm run test:unit`, and publish the file at the rules URL (e.g. commit it to
a GitHub Pages branch). Every installed copy picks it up within a day — no
store submission, because rules are data (CSS selectors), not code. Changes
to code, features or permissions still need a normal store release.

The rules host must serve the file over HTTPS with
`Access-Control-Allow-Origin: *` and **without redirects** (redirects are
refused). The build sets the manifest CSP `connect-src` to that one origin.

Set it at build time:

```bash
RULES_URL=https://<you>.github.io/neat-rules/neat-youtube/rules.json npm run build
```

While it is the placeholder (`https://RULES_HOST/…`) the extension never makes
a network request at all (CSP `connect-src 'none'`).

## Store kit (`store/`)

`title.txt`, `summary.txt` (≤132 chars), `description.txt`, `listing.json`
(single purpose, permission justifications, data-use answers),
`privacy.html`, `site/` (one-page landing site + privacy page),
`screenshots/1-before-after.png`, `2-popup.png`, `3-options.png` (1280×800),
`promo-small-440x280.png`.

## Testing notes

* E2E loads `dist-test/youtube` (built automatically by the `build-ext`
  setup project) into Playwright's Chromium (`channel: "chromium"`, new
  headless supports extensions), pre-sets YouTube's consent cookie (`SOCS`)
  and clicks "Reject all" if a consent dialog appears anyway.
* Oracles are independent of `rules.json`: they count what a user would see
  (visible links to `/shorts/`, a visible "Shorts" tab, …).
* A fresh logged-out profile gets an empty Home; the tests watch two videos
  first so Home has a real feed.
* On Windows inside an app that virtualises `%LOCALAPPDATA%`, install browsers
  to a real folder: `PLAYWRIGHT_BROWSERS_PATH=.browsers npx playwright install chromium`
  and run tests with the same variable.

## Still owed by the owner (manual, one-time)

1. **Chrome Web Store developer account**: register at
   <https://chrome.google.com/webstore/devconsole> (one-time US$5 fee,
   identity verification), then upload `dist/neat-youtube-1.0.0.zip`, paste
   `store/` texts, upload screenshots + promo tile, set the privacy-policy URL,
   answer the data-use form from `store/listing.json`.
2. **After the first upload**, replace `EXTENSION_ID` in
   `apps/youtube/site.config.js` (`reviewUrl`) and in `scripts/store.mjs`
   (`INSTALL_URL`) with the real id; rebuild; `npm run store`.
3. **GitHub**: create the repository, `git remote add origin …`, `git push -u
   origin main`. The canary workflow starts on that push; it needs Actions
   enabled and "Read and write" workflow permissions (Settings → Actions) so
   it can open issues.
4. **Rules host**: choose the URL (e.g. GitHub Pages of a `neat-rules` repo),
   publish `apps/youtube/rules/rules.json` there, rebuild with `RULES_URL=…`,
   and make that the store build.
5. **Host the landing page and privacy policy** (`store/site/`, e.g. GitHub
   Pages) and put the privacy URL in the store listing; add the source-repo
   link to the privacy page's Contact section.
6. **Brand**: if "Neat" changes, edit `brand.config.js`, then `npm run build`,
   `npm run icons`, `npm run store`.
