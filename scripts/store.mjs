// Generates the Chrome Web Store kit in store/:
//   listing text, privacy policy, landing page, 1280x800 screenshots, 440x280 promo tile.
// Screenshots are captured live from YouTube with Playwright (needs network).
//
//   node scripts/store.mjs [site] [--no-shots]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import path from "node:path";
import { BRAND } from "../brand.config.js";
import { TRUST_LINES } from "../packages/engine/src/trust.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const siteName = args.find((a) => !a.startsWith("--")) || "youtube";
const appDir = path.join(ROOT, "apps", siteName);
const { default: site } = await import(new URL(`file:///${path.join(appDir, "site.config.js").replace(/\\/g, "/")}`).href);
const listing = await import(new URL(`file:///${path.join(appDir, "listing.js").replace(/\\/g, "/")}`).href);
const OUT = path.join(ROOT, "store");
const SHOTS = path.join(OUT, "screenshots");
const SITE_OUT = path.join(OUT, "site");
// Owner step after the first store upload: set the 32-letter item id. Until then the
// landing page shows a disabled "pending" button instead of a dead store link.
const EXTENSION_ID = null;
const INSTALL_URL = EXTENSION_ID ? `https://chromewebstore.google.com/detail/${EXTENSION_ID}` : null;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

await mkdir(SHOTS, { recursive: true });
await mkdir(SITE_OUT, { recursive: true });

// ---------------------------------------------------------------- listing text
await writeFile(path.join(OUT, "title.txt"), listing.title + "\n");
await writeFile(path.join(OUT, "summary.txt"), listing.summary + "\n");
await writeFile(path.join(OUT, "description.txt"), listing.description + "\n");
await writeFile(
  path.join(OUT, "listing.json"),
  JSON.stringify(
    {
      title: listing.title,
      titleLength: listing.title.length,
      summary: listing.summary,
      summaryLength: listing.summary.length,
      description: listing.description,
      category: listing.category,
      language: listing.language,
      singlePurpose: `Hide YouTube Shorts and other distracting parts of YouTube that the user chooses.`,
      permissionJustifications: {
        storage: "Saves the user's on/off choices, allow list and the latest hiding rules on this device.",
        alarms: "Checks once a day for updated hiding rules so the extension keeps working when YouTube changes its layout.",
        "host:https://www.youtube.com/*": "Needed to hide elements on YouTube pages. The extension runs on no other site.",
      },
      remoteCode: "No. The extension downloads a JSON rules file containing only CSS selectors and labels; it is strictly validated and never executed.",
      dataUsage: "Collects no user data.",
      screenshots: ["screenshots/1-before-after.png", "screenshots/2-popup.png", "screenshots/3-options.png"],
      promoTile: "promo-small-440x280.png",
      marquee: "marquee-1400x560.png",
      privacyPolicy: "privacy.html",
      privacyPolicyUrl: listing.privacyPolicyUrl,
      homepageUrl: listing.siteUrl,
      sourceUrl: listing.sourceUrl,
    },
    null,
    2,
  ) + "\n",
);

// ---------------------------------------------------------------- shared styles
const pageCss = `
:root{color-scheme:light dark;--bg:#fff;--surface:#f6f7f9;--text:#16181d;--muted:#5c6370;--border:#e1e4ea;--accent:#0f9d76;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#15171c;--surface:#1d2027;--text:#e8eaee;--muted:#9aa2b1;--border:#2e333d;--accent:#34d3a3;--accent-ink:#062b20}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 20px 80px}a{color:var(--accent)}
h1{font-size:clamp(28px,5vw,44px);line-height:1.15;margin:.2em 0 .4em}h2{margin-top:2em}
.brand{display:flex;align-items:center;gap:10px;font-weight:700}.brand img{width:32px;height:32px}
.btn{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:650}
.btn[aria-disabled="true"]{background:var(--surface);color:var(--muted);border:1px dashed var(--border);cursor:not-allowed}
.muted{color:var(--muted)}.trust{list-style:none;padding:0}.trust li{padding:4px 0 4px 26px;position:relative}.trust li:before{content:"✓";position:absolute;left:4px;color:var(--accent);font-weight:700}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:24px 0}.ba figure{margin:0}.ba img{width:100%;border:1px solid var(--border);border-radius:10px;display:block}
.ba figcaption{font-weight:650;margin-bottom:6px}@media (max-width:640px){.ba{grid-template-columns:1fr}}
footer{margin-top:60px;font-size:14px}`;

// ---------------------------------------------------------------- privacy policy
const privacy = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(site.productName)} — Privacy policy</title><style>${pageCss}</style></head>
<body><main>
<p class="brand"><img src="site/icon-128.png" alt="">${esc(site.productName)}</p>
<h1>Privacy policy</h1>
<p class="muted">Last updated: ${new Date().toISOString().slice(0, 10)}</p>
<p><strong>${esc(site.productName)} does not collect, store, sell or share any personal data.</strong> It has no account, no analytics, no advertising and no tracking.</p>
<h2>What stays on your device</h2>
<p>Your settings (which items are hidden, the master switch, your allowed-channels list), the current hiding rules, a short self-check log, and a count of the days you used the extension (used once, to decide whether to show a single “leave a review” card) are kept in your browser's local extension storage. They never leave your device. Uninstalling the extension deletes them.</p>
<h2>The one kind of network request</h2>
<p>So it keeps working when YouTube changes its layout, the extension downloads an updated rules file (a small JSON list of CSS selectors, plus its digital signature) from one fixed HTTPS address: when it is installed or updated, when the browser starts, and once a day — never more than once an hour automatically (you can also check by hand from Options). These requests contain no information about you, your browsing or your settings: no cookies, no identifiers, no history. Like any web request, the server that hosts the file can see the IP address the request came from; we do not log or use it. A rules file is used only if its signature matches the key built into the extension and it passes strict checks; rules can only hide page elements — they cannot run code.</p>
<h2>Permissions</h2>
<ul>
<li><strong>Read and change your data on www.youtube.com</strong> — to hide the parts of YouTube you chose. The extension does not read or record what you watch, and runs on no other site.</li>
<li><strong>Storage</strong> — to save your settings on this device.</li>
<li><strong>Alarms</strong> — to check for updated rules once a day.</li>
</ul>
<h2>Children</h2><p>The extension collects no data from anyone, including children.</p>
<h2>Changes</h2><p>If this policy ever changes, the new version will be published at this address before the change takes effect.</p>
<h2>Contact</h2><p>Questions: ${listing.sourceUrl ? `open an issue at <a href="${esc(listing.sourceUrl)}">${esc(listing.sourceUrl)}</a>` : "open an issue in the project's public source repository (link added at publication)"}.</p>
<p class="muted">${esc(BRAND)} is not affiliated with or endorsed by YouTube or Google.</p>
</main></body></html>
`;
await writeFile(path.join(OUT, "privacy.html"), privacy);
await writeFile(path.join(SITE_OUT, "privacy.html"), privacy.replace('src="site/icon-128.png"', 'src="icon-128.png"').replace("</main>", '<p><a href="./">← Home</a></p>\n</main>'));

// ---------------------------------------------------------------- landing page
const landing = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>How to hide YouTube Shorts — ${esc(site.productName)}</title>
<meta name="description" content="${esc(listing.summary)}">
<link rel="icon" href="icon-128.png">
<style>${pageCss}</style></head>
<body><main>
<p class="brand"><img src="icon-128.png" alt="">${esc(BRAND)}</p>
<h1>How to hide YouTube Shorts</h1>
<p>Install <strong>${esc(site.productName)}</strong>, a free Chrome extension. ${esc(listing.firstLine)} No settings to learn: Shorts disappear from Home, search, subscriptions, channel pages and the sidebar, and any Shorts link opens as a normal video.</p>
${INSTALL_URL
  ? `<p><a class="btn" href="${INSTALL_URL}" id="install">Add to Chrome — it's free</a></p>`
  : `<p><span class="btn" id="install" role="link" aria-disabled="true" data-pending="store-id">Add to Chrome — coming soon</span><br><span class="muted">Pending Chrome Web Store review. The install link appears here once the extension is published.</span></p>`}
<ul class="trust">${TRUST_LINES.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
${listing.sourceUrl ? `<p><a href="${esc(listing.sourceUrl)}">Source code</a></p>` : ""}
<div class="ba">
  <figure><figcaption>Before</figcaption><img src="before.png" alt="YouTube Home with a Shorts shelf and Shorts in the sidebar"></figure>
  <figure><figcaption>After</figcaption><img src="after.png" alt="The same YouTube Home with Shorts removed"></figure>
</div>
<h2>What it does</h2>
<ul>${listing.benefits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
<h2>Steps</h2>
<ol><li>Click <em>Add to Chrome</em>.</li><li>Open YouTube. Shorts are gone.</li><li>Optional: click the ${esc(BRAND)} icon to choose exactly what to hide.</li></ol>
<h2>Is it safe?</h2>
<p>${esc(listing.disclosure)}</p>
<footer class="muted"><a href="privacy.html">Privacy policy</a> · ${esc(BRAND)} is not affiliated with YouTube or Google.</footer>
</main></body></html>
`;
await writeFile(path.join(SITE_OUT, "index.html"), landing);
await cp(path.join(appDir, "icons", "icon-128.png"), path.join(SITE_OUT, "icon-128.png"));

if (args.includes("--no-shots")) {
  console.log("store/ text written (screenshots skipped)");
  process.exit(0);
}

// ---------------------------------------------------------------- screenshots
const EXT = path.join(ROOT, "dist-store", siteName);
execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), siteName, "--skip-tests", "--out", "dist-store"], { cwd: ROOT, stdio: "inherit" });
const { launch, openYouTube, warmUpHome, extensionWorker } = await import("../tests/e2e/helpers.js");

// Both shots use the same scroll position: where the first Shorts shelf sits in the "before" feed.
let shelfY = 0;
async function homeShot(withExtension) {
  const ctx = await launch({ extension: withExtension, extDir: EXT, viewport: { width: 1280, height: 800 } });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.emulateMedia({ colorScheme: "light" });
    await warmUpHome(page);
    await openYouTube(page, site.id === "youtube" ? "https://www.youtube.com/" : "", "home");
    if (!withExtension) {
      shelfY = await page.evaluate(() => {
        const shelf = [...document.querySelectorAll('ytd-browse[page-subtype="home"] ytd-rich-section-renderer')].find((s) => s.querySelector('a[href^="/shorts/"]'));
        return shelf ? Math.max(0, shelf.getBoundingClientRect().top + window.scrollY - 330) : 0;
      });
    }
    await page.evaluate((y) => window.scrollTo(0, y), shelfY);
    await page.waitForTimeout(1500);
    return await page.screenshot();
  } finally {
    await ctx.close();
  }
}
const before = await homeShot(false);
const after = await homeShot(true);
await writeFile(path.join(SITE_OUT, "before.png"), before);
await writeFile(path.join(SITE_OUT, "after.png"), after);

const browser = await chromium.launch();
const comp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await comp.emulateMedia({ colorScheme: "light" });
const dataUrl = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
const icon = await readFile(path.join(appDir, "icons", "icon-128.png"));
const frameCss = `*{box-sizing:border-box}body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:system-ui,"Segoe UI",Roboto,sans-serif;background:linear-gradient(135deg,#e9fbf4,#c9efe1);color:#10251e}
h1{margin:0;font-size:40px;letter-spacing:-.01em}.sub{color:#2d5247;font-size:20px;margin-top:6px}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:22px}.brand img{width:40px;height:40px}`;

// 1: before / after split
await comp.setContent(`<html><head><style>${frameCss}
.wrap{padding:36px 40px}.panes{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:26px}
figure{margin:0}figcaption{font-weight:700;font-size:20px;margin-bottom:10px}figcaption span{display:inline-block;padding:3px 12px;border-radius:999px;background:#fff}
figure.after figcaption span{background:#0f9d76;color:#fff}
img.shot{width:100%;border-radius:12px;box-shadow:0 10px 30px rgba(0,40,30,.18);display:block}
</style></head><body><div class="wrap">
<div class="brand"><img src="${dataUrl(icon)}">${esc(site.productName)}</div>
<h1 style="margin-top:14px">${esc(listing.firstLine)}</h1>
<div class="panes"><figure><figcaption><span>Before</span></figcaption><img class="shot" src="${dataUrl(before)}"></figure>
<figure class="after"><figcaption><span>After</span></figcaption><img class="shot" src="${dataUrl(after)}"></figure></div>
</div></body></html>`);
await comp.waitForFunction(() => [...document.images].every((i) => i.complete));
await comp.screenshot({ path: path.join(SHOTS, "1-before-after.png") });

// 2: popup, 3: options — captured from the real extension pages
const ctx = await launch({ extDir: EXT, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const sw = await extensionWorker(ctx);
const id = new URL(sw.url()).host;
const p = ctx.pages()[0] || (await ctx.newPage());
await p.emulateMedia({ colorScheme: "light" });
await p.setViewportSize({ width: 340, height: 800 });
await p.goto(`chrome-extension://${id}/popup.html`);
await p.locator("body.ready").waitFor();
await p.waitForTimeout(400);
const popupShot = await p.locator("body").screenshot({ scale: "device" });
await p.setViewportSize({ width: 1280, height: 800 });
await p.goto(`chrome-extension://${id}/options.html`);
await p.locator("body.ready").waitFor();
await p.waitForTimeout(400);
await p.screenshot({ path: path.join(SHOTS, "3-options.png"), scale: "css" });
await ctx.close();

await comp.setContent(`<html><head><style>${frameCss}
.wrap{display:grid;grid-template-columns:1fr 420px;gap:56px;align-items:center;height:800px;padding:0 80px}
.pop{background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(0,40,30,.25);overflow:hidden;width:380px;justify-self:center}.pop img{width:100%;display:block}
ul{font-size:20px;line-height:1.7;padding-left:22px;color:#1d3a31}
</style></head><body><div class="wrap"><div>
<div class="brand"><img src="${dataUrl(icon)}">${esc(BRAND)}</div>
<h1 style="margin-top:16px">Choose exactly what to hide</h1>
<p class="sub">One master switch. Every option changes the page instantly — no reload.</p>
<ul><li>Shorts everywhere, on by default</li><li>Comments, end screens, recommendations — your call</li><li>Alt+Shift+Y turns it all off and on</li></ul>
</div><div class="pop"><img src="${dataUrl(popupShot)}"></div></div></body></html>`);
await comp.waitForFunction(() => [...document.images].every((i) => i.complete));
await comp.screenshot({ path: path.join(SHOTS, "2-popup.png") });

// Promo tile 440x280 (required by the store listing)
const tile = await browser.newPage({ viewport: { width: 440, height: 280 } });
await tile.setContent(`<html><head><style>${frameCss}body{width:440px;height:280px;display:flex;flex-direction:column;justify-content:center;padding:0 36px}
.brand img{width:56px;height:56px}.brand{font-size:30px}p{font-size:21px;margin:14px 0 0;font-weight:600;color:#1d3a31}</style></head>
<body><div class="brand"><img src="${dataUrl(icon)}">${esc(BRAND)}</div><p>${esc(listing.firstLine)}</p></body></html>`);
await tile.waitForFunction(() => [...document.images].every((i) => i.complete));
await tile.screenshot({ path: path.join(OUT, "promo-small-440x280.png") });
// Marquee 1400x560 (needed to be considered for featuring)
const marquee = await browser.newPage({ viewport: { width: 1400, height: 560 } });
await marquee.setContent(`<html><head><style>${frameCss}body{width:1400px;height:560px;display:grid;grid-template-columns:520px 1fr;align-items:center;gap:40px;padding:0 70px}
.brand img{width:72px;height:72px}.brand{font-size:40px}h1{font-size:48px;margin-top:18px}.shot{width:100%;border-radius:14px;box-shadow:0 18px 50px rgba(0,40,30,.25)}</style></head>
<body><div><div class="brand"><img src="${dataUrl(icon)}">${esc(BRAND)}</div><h1>${esc(listing.firstLine)}</h1></div><img class="shot" src="${dataUrl(after)}"></body></html>`);
await marquee.waitForFunction(() => [...document.images].every((i) => i.complete));
await marquee.screenshot({ path: path.join(OUT, "marquee-1400x560.png") });
await browser.close();
await rm(path.join(ROOT, "dist-store"), { recursive: true, force: true });
console.log(`store kit written to ${path.relative(ROOT, OUT)}`);
