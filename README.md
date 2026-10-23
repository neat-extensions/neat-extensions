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
  store.mjs                generates store/ (texts, privacy, landing, screenshots)
  icons.mjs                renders the SVG icon to 16/32/48/128 PNGs
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

### Publishing (GitHub Pages, `docs/` on `main`)

The rules host is GitHub Pages of this repository, published from the
`docs/` folder of `main`:

| What | URL |
|---|---|
| rules | <https://neat-extensions.github.io/neat-extensions/youtube/rules.json> (+ `.sig`) |
| landing page | <https://neat-extensions.github.io/neat-extensions/> |
| privacy policy | <https://neat-extensions.github.io/neat-extensions/privacy.html> |

`docs/` is generated, never edited by hand. **To fix a YouTube breakage:**

1. edit `apps/youtube/rules/rules.json` and bump `version`;
2. `npm run test:unit` (and `npm run test:e2e` if you can);
3. `npm run rules:publish`.

`rules:publish` validates the rules, signs them with the private key
(`.secrets/rules-private.jwk`, or `RULES_PRIVATE_KEY_FILE`), checks the
signature against `site.config.js → rulesPublicKey`, writes
`docs/youtube/rules.json` + `.sig` and the landing/privacy pages from
`store/site/`, commits and pushes. It refuses changed rules with an unchanged
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
* On Windows inside an app that virtualises `%LOCALAPPDATA%`, install browsers
  to a real folder: `PLAYWRIGHT_BROWSERS_PATH=.browsers npx playwright install chromium`
  and run tests with the same variable.

## Still owed by the owner (manual, one-time)

Done: GitHub repo (public), Actions with read/write permissions, repository
variables `RULES_URL` / `RULES_PUBLIC_KEY`, signing key, Pages hosting of the
rules + landing page + privacy policy, `sourceUrl`.

1. **Chrome Web Store developer account**: register at
   <https://chrome.google.com/webstore/devconsole> (one-time US$5 fee,
   identity verification), then upload `dist/neat-youtube-1.0.0.zip`, paste
   `store/` texts, upload screenshots + promo tile, set the privacy-policy URL
   (`store/listing.json → privacyPolicyUrl`), answer the data-use form from
   `store/listing.json`.
2. **After the first upload**, set `EXTENSION_ID` in `scripts/store.mjs`
   (until then the landing page shows a disabled "coming soon" button), then
   `npm run store -- --no-shots` and `npm run rules:publish` to republish the
   landing page. (The in-extension review link uses the runtime id and needs
   no change.)
3. **Brand**: if "Neat" changes, edit `brand.config.js`, then `npm run build`,
   `npm run icons`, `npm run store`.
