// Store kit and public pages for Neat Record (npm run store -- record):
//   store/record/   title, summary, description, listing.json, privacy.html,
//                   screenshots/1-5 (1280×800), promo-small-440x280.png, marquee-1400x560.png
//   docs/record/    help.html (steps with real screenshots + drawn arrows), pro.html (Free vs Pro poster),
//                   privacy.html, images — published by GitHub Pages
// Screenshots come from the real extension (a throwaway e2e build, deleted after), driven
// with Playwright on a local demo page. Arrows and the poster are drawn here, in code.
//   node scripts/store-record.mjs [--no-shots]
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { BRAND, movedHead, SUPPORT_EMAIL } from "../brand.config.js";
import app from "../apps/record/app.config.js";
import * as listing from "../apps/record/listing.js";
import { PRESETS, sizeLabel } from "../apps/record/src/lib/presets.js";
import { FREE, PRO, TERMS } from "../apps/record/src/lib/compare.js";
import { ICONS } from "../apps/record/src/lib/ui.js";
import { TOKENS } from "../apps/record/src/lib/tokens.js";
import { generateLicenceKeyPair, signLicence } from "./licence-sign.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "store", "record");
const SHOTS = path.join(OUT, "screenshots");
const DOCS = path.join(ROOT, "docs", "record");
const ASSETS = path.join(ROOT, "apps", "record", "store");
const args = process.argv.slice(2);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const today = new Date().toISOString().slice(0, 10);
const placeholderBuy = /PAYMENT_LINK/.test(app.buyUrl);

await mkdir(SHOTS, { recursive: true });
await mkdir(DOCS, { recursive: true });

// ---------------------------------------------------------------- icons as inline SVG strings
function svg(name, size = 24, color = "currentColor") {
  const paths = (ICONS[name] || [])
    .map((p) =>
      typeof p === "object" && p.fill
        ? `<path d="${p.d}" fill="${color}"/>`
        : `<path d="${typeof p === "object" ? p.d : p}" fill="none" stroke="${color}" stroke-width="${name === "grip" ? 2.6 : 1.75}" stroke-linecap="round" stroke-linejoin="round"${typeof p === "object" && p.dash ? ` stroke-dasharray="${p.dash}"` : ""}/>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${paths}</svg>`;
}

// ---------------------------------------------------------------- listing text
await writeFile(path.join(OUT, "title.txt"), listing.title + "\n");
await writeFile(path.join(OUT, "summary.txt"), listing.summary + "\n");
await writeFile(path.join(OUT, "description.txt"), listing.description + "\n");
const SCREENSHOTS = ["screenshots/1-draw-a-box.png", "screenshots/2-panel.png", "screenshots/3-recording.png", "screenshots/4-free-vs-pro.png", "screenshots/5-saved-and-shared.png"];
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
      singlePurpose: "Record the user's screen — a box drawn on a web page, the whole screen, one window, or the current tab — save the video to the user's computer, and optionally share it through the user's own Google Drive.",
      permissionJustifications: {
        tabCapture: "Records the current tab (and the part of it inside a drawn box) when the user presses Record.",
        offscreen: "Runs the recorder (capture, encoding and saving) in an offscreen document, because a service worker cannot record media.",
        activeTab: "Lets the extension act only on the tab where the user clicked its icon or pressed its shortcut: to record that tab and show the recording controls there.",
        scripting: "Shows the draw-a-box overlay, the small recording bar, the webcam bubble and the 'saved' card on that same tab, from a file inside the extension. Only after the user clicks; never on its own.",
        downloads: "Saves the finished video (and trimmed copies or GIFs the user asks for) to the user's Downloads folder.",
        storage: "Remembers the user's choices (mode, microphone, sound, quality), the ID of the 'Neat' folder in the user's Drive if Share was used, the date the 10-minute note was last shown, and, if bought, the Pro licence key.",
        identity: "Only for Share (Pro): asks Google, after the user presses Share and clicks Allow, for permission to create files in the user's own Drive (drive.file scope) and uploads that one video.",
        "web_accessible_resources (camera.html)": "The webcam bubble (Pro) is a small extension page shown on the recorded tab, so the camera appears in the recording. It is loaded with a dynamic URL.",
        "commands (Alt+Shift+R)": "Keyboard shortcut: stops a recording (anyone) or starts one (Pro).",
        hostPermissions: "None.",
      },
      remoteCode: "No. All code is in the package. The only network use is Google Drive (googleapis.com), and only after the user presses Share.",
      dataUsage: {
        collected: "Website content — only when the user presses Share (Pro): the one recording they chose is uploaded straight from the browser to the user's own Google Drive. The developer never receives it. Nothing else is collected; otherwise videos are recorded, encoded and saved on the user's computer. (Buying Pro happens on a web page outside the extension; its data handling is in the privacy policy.)",
        formAnswer: "Tick only 'Website content'. Leave every other data type unticked.",
        driveShare:
          "When the user presses Share (Pro), the chosen video is uploaded to the user's own Google Drive using Google's drive.file scope (the extension can only see files it created) and set to 'anyone with the link can view'. The developer never receives the video, the link or any account data.",
        certifications: ["Does not sell or transfer user data to third parties", "Does not use or transfer user data for purposes unrelated to the single purpose", "Does not use or transfer user data to determine creditworthiness or for lending"],
      },
      oauth: { scopes: [app.driveScope], sensitivity: "non-sensitive (Google Drive API scope table, 'Non-sensitive scopes')" },
      payments: `Pro is a one-off ${app.price} purchase through Stripe Checkout (a web page), unlocked with an offline-verified licence key. The extension never handles card details.`,
      screenshots: SCREENSHOTS,
      promoTile: "promo-small-440x280.png",
      marquee: "marquee-1400x560.png",
      privacyPolicy: "privacy.html",
      privacyPolicyUrl: listing.privacyPolicyUrl,
      homepageUrl: listing.siteUrl,
      supportUrl: `mailto:${SUPPORT_EMAIL}`,
      sourceUrl: listing.sourceUrl,
    },
    null,
    2,
  ) + "\n",
);

// ---------------------------------------------------------------- shared page style
const pageCss = `${TOKENS.replaceAll(":host, :root", ":root")}
*{box-sizing:border-box}body{margin:0;background:var(--surface-2);color:var(--text);font:18px/1.6 var(--font)}
main{max-width:880px;margin:0 auto;padding:40px 20px 80px}a{color:var(--accent)}
.brand{display:flex;align-items:center;gap:12px;font-weight:700;font-size:18px;text-decoration:none;color:var(--text)}.brand img{width:36px;height:36px;border-radius:8px}
h1{font-size:clamp(30px,5vw,46px);line-height:1.1;margin:24px 0 8px;letter-spacing:-.02em}h2{font-size:26px;margin:48px 0 12px;letter-spacing:-.01em}
.muted{color:var(--muted)}.btn{display:inline-flex;align-items:center;justify-content:center;height:52px;padding:0 28px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-weight:650;text-decoration:none;box-shadow:0 6px 16px rgba(214,54,60,.3)}
.btn[aria-disabled="true"]{background:var(--surface-3);color:var(--muted);box-shadow:none;cursor:not-allowed}
footer{margin-top:64px;font-size:15px}footer a{margin-right:16px}
img.shot{display:block;width:100%;height:auto;border-radius:16px;box-shadow:var(--shadow-lg)}`;

// ---------------------------------------------------------------- privacy policy
const privacy = (home) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(app.productName)} — Privacy policy</title>
${movedHead("record/privacy.html")}<style>${pageCss}</style></head>
<body><main>
<a class="brand" href="${home}"><img src="icon-128.png" alt="">${esc(app.productName)}</a>
<h1>Privacy policy</h1>
<p class="muted">Last updated: ${today}</p>
<p><strong>The extension collects nothing about you.</strong> No account, no analytics, no advertising, no tracking, and no server of ours ever sees your videos. The only personal data we handle is your email address if you buy Pro — see "Buying Pro" below.</p>
<h2>Your videos</h2>
<p>Recording, encoding and saving happen on your computer. The finished video goes to your Downloads folder. While it is being made it is kept in the extension's private storage on your computer and deleted once it is saved. Pro keeps the last video there until you start a new recording or restart your browser, so Share, Trim and GIF can still use it (the panel's "Last recording"). If the browser or the computer stops in the middle of a recording, what was recorded is saved to Downloads the next time the browser starts, then deleted from the extension's storage.</p>
<h2>Share to Google Drive (Pro, optional)</h2>
<p>Only when you press <strong>Share</strong>, Chrome asks Google for permission for ${esc(app.productName)} to create files in your Google Drive. It uses Google's <code>drive.file</code> permission: the extension can see and change <em>only the files it created itself</em> — never anything else in your Drive. The video you chose is uploaded straight from your browser to your own Drive, into a folder called "${esc(BRAND)}", and set so that anyone with the link can view it. The link is copied for you. Sharing never sends us the video, the link, your Google account or your email address. You can remove the permission at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, and delete shared videos in Drive.</p>
<p>${esc(app.productName)}'s use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>What is remembered on your computer</h2>
<p>Your choices (what to record, microphone, sound, quality), the id of the "${esc(BRAND)}" folder in your Drive if you used Share, and the date the 10-minute note was last shown. If you buy Pro, your licence key is kept in Chrome's sync storage so your other computers signed in to Chrome unlock too. Uninstalling the extension deletes all of it.</p>
<h2>Buying Pro</h2>
<p>Payment is handled by Stripe on Stripe's own page; we never see your card. After you pay, our small licence service (running on Cloudflare) asks Stripe whether the payment went through, makes your key, and shows it to you.</p>
<ul>
<li><strong>What it keeps:</strong> the key, an id for it made from the purchase id (used only if you ask for a refund or a key is shared publicly), the purchase id and the date — so the same key can be shown again if you reload the page. This contains nothing about who you are.</li>
<li><strong>Your email address</strong> (from Stripe) is used once, to email you the key through <a href="https://www.brevo.com/legal/privacypolicy/">Brevo</a>, our email sender, and is deleted from our licence service as soon as the email has gone out (or after five failed tries). Brevo keeps a log of sent emails for a short time under its own policy.</li>
<li><strong>Stripe</strong> sells Pro for us (Stripe Managed Payments) and collects what it needs for the payment and for tax, such as your country. Stripe keeps its own receipt records — see <a href="https://stripe.com/privacy">Stripe's privacy policy</a>.</li>
<li>Our licence service runs on Cloudflare, which processes your IP address to deliver the page.</li>
<li>The key itself contains no personal data. It is stored in Chrome's sync storage so your other computers signed in to Chrome unlock too.</li>
<li>To have your purchase record deleted, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> with the last 6 characters of your key.</li>
</ul>
<h2>Permissions</h2>
<ul>
<li><strong>Capture the tab / screen</strong> — to record what you chose, only after you press Record.</li>
<li><strong>Downloads</strong> — to save your video.</li>
<li><strong>Act on the current tab when you click</strong> (activeTab, scripting) — to show the box, the recording bar, the webcam bubble and the "Saved" card on that tab. Never on its own.</li>
<li><strong>Google sign-in</strong> (identity) — only for Share, only after you click it.</li>
<li><strong>Microphone and camera</strong> (Chrome asks the first time) — your voice and your face go only into the video on your computer.</li>
<li><strong>Storage</strong> — your choices, as above.</li>
</ul>
<h2>Children</h2><p>The extension collects no data from anyone, including children.</p>
<h2>Changes</h2><p>If this policy changes, the new version is published here before the change takes effect.</p>
<h2>Contact</h2><p>Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>, or open an issue at <a href="${esc(listing.sourceUrl)}/issues">${esc(listing.sourceUrl.replace("https://", ""))}/issues</a>.</p>
<p class="muted">${esc(BRAND)} is not affiliated with or endorsed by Google.</p>
<footer><a href="help.html">Help</a><a href="pro.html">Pro</a><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a><a href="${esc(listing.sourceUrl)}">Source code</a></footer>
</main></body></html>
`;
await writeFile(path.join(OUT, "privacy.html"), privacy("help.html"));
await writeFile(path.join(DOCS, "privacy.html"), privacy("help.html"));
await cp(path.join(ROOT, "apps", "record", "icons", "icon-128.png"), path.join(DOCS, "icon-128.png"));
await cp(path.join(ROOT, "apps", "record", "icons", "icon-128.png"), path.join(OUT, "icon-128.png"));

// ---------------------------------------------------------------- poster (Free vs Pro)
const TILES = [
  { icon: "ways", text: "4 ways", free: true },
  { icon: "mic", text: "Mic + sound", free: true },
  { icon: "check", text: "No watermark", free: true },
  { icon: "screen", text: "1080p", free: true },
  { icon: "countdown", text: "10 min", pro: "No limit", free: "limited" },
  { icon: "screen", text: "4K", free: false },
  { icon: "link", text: "Drive link", free: false },
  { icon: "camera", text: "Webcam", free: false },
  { icon: "click", text: "Clicks", free: false },
  { icon: "pause", text: "Pause", free: false },
  { icon: "scissors", text: "Trim", free: false },
  { icon: "gif", text: "GIF", free: false },
];
const person = await readFile(path.join(ASSETS, "person.svg"), "utf8");
function posterHtml() {
  const tile = (t, side) => {
    const on = side === "pro" || t.free === true || t.free === "limited";
    const label = side === "pro" && t.pro ? t.pro : t.text;
    const mark = !on ? `<span class="mk off">${svg("lock", 18)}</span>` : `<span class="mk on">${svg("check", 18)}</span>`;
    const ic = side === "pro" && t.pro ? `<span class="inf">∞</span>` : t.icon === "ways" ? `<span class="ways4">${["box", "screen", "window", "tab"].map((n) => svg(n, 22)).join("")}</span>` : svg(t.icon, 34);
    return `<div class="tile ${on ? "" : "dim"} ${t.free === "limited" && side === "free" ? "lim" : ""}">${mark}<div class="ic">${ic}</div><div class="tl">${esc(label)}</div></div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS.replaceAll(":host, :root", ":root")}
*{box-sizing:border-box}html,body{margin:0;width:1280px;height:800px;overflow:hidden;font-family:var(--font);color-scheme:light}
.wrap{display:grid;grid-template-columns:1fr 1fr;height:800px}
.side{position:relative;padding:40px 44px;display:grid;grid-template-rows:170px 1fr 80px}
.free{background:#f4f4f6}.pro{background:linear-gradient(160deg,#fff 0%,#fff1f0 100%);border-left:1px solid #f0d9d8}
.head h2{margin:0;font-size:64px;letter-spacing:-.03em;line-height:1;color:#111114}.head p{margin:12px 0 0;font-size:28px;font-weight:650;color:#62626d}
.pro .head p{color:#d6363c}
.person{position:absolute;right:28px;top:14px;width:200px;height:200px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:150px;gap:14px;align-content:start}
.tile{position:relative;background:#fff;border-radius:18px;display:grid;justify-items:center;align-content:center;gap:10px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 6px 18px rgba(0,0,0,.06);color:#111114}
.tile .ic{color:#d6363c;height:40px;display:grid;place-items:center}.tile .tl{font-size:17px;font-weight:650}
.tile.dim{background:transparent;box-shadow:none;border:2px dashed #d4d4da;color:#a3a3ab}.tile.dim .ic{color:#c4c4cc}
.tile.lim .tl{color:#62626d}
.mk{position:absolute;top:10px;right:10px;width:28px;height:28px;border-radius:50%;display:grid;place-items:center}
.mk.on{background:#18794e;color:#fff}.mk.off{background:#e8e8ec;color:#8a8a94}
.inf{font-size:44px;line-height:40px;font-weight:700}.ways4{display:grid;grid-template-columns:repeat(4,22px);gap:4px}
.foot{display:flex;align-items:center;gap:16px;font-size:26px;font-weight:700}
.price{display:inline-flex;align-items:center;height:60px;padding:0 30px;border-radius:999px;background:#d6363c;color:#fff;box-shadow:0 8px 20px rgba(214,54,60,.35)}
.zero{color:#62626d}
.logo{position:absolute;left:400px;bottom:34px;display:flex;gap:10px;align-items:center;font:700 18px var(--font);color:#111114;background:#fff;padding:8px 16px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.08);z-index:2}
.logo img{width:24px;height:24px;border-radius:6px}
</style></head><body><div class="logo"><img src="ICON">${esc(app.productName)}</div><div class="wrap">
<section class="side free"><div class="head"><h2>Free</h2><p>Forever</p></div><div class="grid">${TILES.map((t) => tile(t, "free")).join("")}</div><div class="foot"><span class="zero">$0</span></div></section>
<section class="side pro"><div class="person">${person}</div><div class="head"><h2>Pro</h2><p>Everything</p></div><div class="grid">${TILES.map((t) => tile(t, "pro")).join("")}</div><div class="foot"><span class="price">${esc(app.price)} once</span></div></section>
</div></body></html>`;
}

// ---------------------------------------------------------------- help + pro pages
// The four modes, in the panel's order, in the owner's words.
const WAYS = [
  { icon: "box", name: "Draw a box", text: "You draw a box on the page. Only what is inside the box goes in the video. Everything outside stays out." },
  { icon: "screen", name: "Screen", text: "Everything on your monitor goes in the video — all your windows, the taskbar, everything you see." },
  { icon: "window", name: "Window", text: "Pick one program, say Excel. Only Excel goes in the video. If you open something on top of it, that doesn't go in.", note: "Sound is off in Window mode — your browser can't record one window's sound. Use Screen or This page for sound." },
  { icon: "tab", name: "This page", text: "Only the web page you are on right now goes in the video. If you switch to another tab, the video keeps filming this one — nothing else gets in by accident." },
];
const help = (imgs) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>How to record your screen — ${esc(app.productName)}</title>
${movedHead("record/help.html")}
<meta name="description" content="Record part of a web page, your whole screen, a window or the page you're on, in Chrome or Edge. Press Record, draw a box, your video is in Downloads.">
<link rel="icon" href="icon-128.png">
<style>${pageCss}
.step{display:grid;grid-template-columns:72px 1fr;gap:20px;margin:40px 0;align-items:start}
.num{width:72px;height:72px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font:800 36px/1 var(--font)}
.step h2{margin:6px 0 16px;font-size:30px}.step p{margin:0 0 16px;font-size:20px}
.ways{display:grid;gap:12px;margin-top:16px}.way{display:grid;grid-template-columns:48px 1fr;gap:16px;align-items:start;background:var(--surface);border-radius:16px;padding:16px 20px;box-shadow:var(--shadow)}
.way-icon{width:48px;height:48px;border-radius:12px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center}.way-note{margin:8px 0 0;font-size:16px}
.levels{display:grid;gap:12px;margin-top:16px}.level{display:grid;grid-template-columns:120px 1fr;gap:16px;align-items:center;background:var(--surface);border-radius:16px;padding:16px 20px;box-shadow:var(--shadow)}
.level b{font-size:22px}.pill{display:inline-block;margin-left:8px;padding:2px 10px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:14px;font-weight:650}
@media (max-width:640px){.step{grid-template-columns:1fr}.num{width:56px;height:56px;font-size:28px}}
</style></head>
<body><main>
<a class="brand" href="help.html"><img src="icon-128.png" alt="">${esc(app.productName)}</a>
<h1>How to record your screen</h1>
<p class="muted">There are 4 ways to record. Pick one. Then follow the steps.</p>
<h2 id="ways">Four ways to record</h2>
<div class="ways">
${WAYS.map((w) => `<div class="way"><span class="way-icon">${svg(w.icon, 28)}</span><div><b>${esc(w.name)}</b> — ${esc(w.text)}${w.note ? `<p class="muted way-note">${esc(w.note)}</p>` : ""}</div></div>`).join("\n")}
</div>
${imgs
  .map(
    (s, i) => `<section class="step" id="step-${i + 1}"><div class="num" aria-hidden="true">${i + 1}</div><div><h2>${esc(s.title)}</h2><p>${s.text}</p><img class="shot" src="${s.img}" alt="${esc(s.alt)}" width="1280" height="800" loading="${i < 2 ? "eager" : "lazy"}"></div></section>${i === 3 ? `<h2 id="share">Share it (Pro)</h2>` : ""}`,
  )
  .join("\n")}
<h2 id="quality">Good, Better or Best?</h2>
<p>Pick one under the switches before you press Record.</p>
<div class="levels">
${PRESETS.map((p) => `<div class="level"><b>${esc(p.label)}${p.pro ? '<span class="pill">Pro</span>' : ""}</b><div>${esc(p.id === "good" ? "Small files. Fine for a quick message." : p.id === "better" ? "Sharp and clear. The one to use most days." : "Super sharp, for big screens and tiny text.")}<br><span class="muted">${esc(p.detail)} · ${esc(sizeLabel(p))}</span></div></div>`).join("\n")}
</div>
<p class="muted" style="margin-top:16px">Free recordings can be up to ${app.freeLimitMinutes} minutes long. At ${app.freeLimitMinutes}:00 the recording stops by itself and is saved — nothing is lost. <a href="pro.html">Pro</a> has no limit.</p>
<h2 id="trouble">If something doesn't work</h2>
<ul>
<li><b>“This page can't be recorded”</b> — your browser doesn't let anyone record its own pages, like its start page. Open a normal website, or pick Screen or Window.</li>
<li><b>No sound in Window mode</b> — your browser can't record one window's sound. Use Screen or This page for sound.</li>
<li><b>No computer sound with Screen</b> — in the window that asks what to share, turn on <b>Share system audio</b> (Edge: <b>Share with system audio</b>) before you press Share.</li>
<li><b>The camera circle says “Camera blocked”</b> — some websites don't allow cameras. Turn Camera off for that site, or allow the camera in the address bar.</li>
<li><b>Your browser asked where to save, and you closed that window</b> — press <b>Save again</b>.</li>
<li><b>Alt+Shift+R does nothing</b> (Pro) — your browser didn't set the shortcut: open <b>chrome://extensions/shortcuts</b> (in Edge, <b>edge://extensions/shortcuts</b>) and type Alt+Shift+R into the box next to ${esc(app.productName)}.</li>
</ul>
<footer><a href="pro.html">Pro</a><a href="privacy.html">Privacy</a><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a><a href="${esc(listing.sourceUrl)}">Source code</a></footer>
</main></body></html>
`;

const proPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(app.productName)} Pro — Free vs Pro</title>
${movedHead("record/pro.html")}
<meta name="description" content="${esc(app.productName)} is free forever. Pro adds no time limit, 4K, a Google Drive share link, webcam, trim and GIF for ${esc(app.price)} once.">
<link rel="icon" href="icon-128.png">
<style>${pageCss}
.poster{margin:24px 0}.buy{display:grid;justify-items:center;gap:10px;text-align:center;margin:32px 0}
ul.list{columns:2;padding-left:20px}@media (max-width:640px){ul.list{columns:1}}
</style></head>
<body><main>
<a class="brand" href="help.html"><img src="icon-128.png" alt="">${esc(app.productName)}</a>
<h1>Free vs Pro</h1>
<img class="shot poster" src="poster.png" width="1280" height="800" alt="Free: any screen, mic and sound, no watermark, 1080p, 10 minutes. Pro adds: no limit, 4K, Drive link, webcam, click highlights, pause, trim, GIF.">
<div class="buy">
${placeholderBuy ? `<span class="btn" id="buy" role="link" aria-disabled="true" data-pending="payment-link">Get Pro — coming soon</span><span class="muted">Pro goes on sale here soon.</span>` : `<a class="btn" id="buy" href="${esc(app.buyUrl)}">Get Pro — ${esc(app.price)} once</a>`}
<span class="muted">Paid on Stripe's secure page. We never see your card.</span>
</div>
<h2>Pro adds</h2>
<ul class="list">${PRO.map((p) => `<li>${esc(p.text)}</li>`).join("")}</ul>
<h2>Free, forever</h2>
<ul class="list">${FREE.map((p) => `<li>${esc(p.text)}</li>`).join("")}</ul>
<h2>After you buy</h2>
<p>You get a key straight away, on the screen and by email. It's a long line of letters.</p>
<ol><li>Click the ${esc(app.productName)} icon.</li><li>Press <b>Pro</b>.</li><li>Paste the key and press <b>Unlock Pro</b>.</li></ol>
<p>If Chrome sync is on, your other computers with the same Chrome sign-in unlock by themselves.</p>
<p>Questions or a problem with your key? Email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
<p class="muted">${esc(TERMS)} No account. No monthly fee.</p>
<footer><a href="help.html">Help</a><a href="privacy.html">Privacy</a><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a><a href="${esc(listing.sourceUrl)}">Source code</a></footer>
</main></body></html>
`;
await writeFile(path.join(DOCS, "pro.html"), proPage);
// neatextensions.com/record/ itself: send people to the help page.
await writeFile(
  path.join(DOCS, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(app.productName)}</title>
${movedHead("record/help.html")}<meta http-equiv="refresh" content="0; url=help.html"></head>
<body><p><a href="help.html">${esc(app.productName)} — how to record your screen</a></p></body></html>
`,
);

if (args.includes("--no-shots")) {
  console.log("store/record text and docs/record pages written (screenshots skipped)");
  process.exit(0);
}

// ---------------------------------------------------------------- screenshots from the real extension
const { privateJwk, publicJwk } = await generateLicenceKeyPair();
execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), "record", "--skip-tests", "--test", "--out", "dist-store"], { cwd: ROOT, stdio: "inherit", env: { ...process.env, RECORD_LICENCE_PUBLIC_KEY: JSON.stringify(publicJwk) } });
const EXT = path.join(ROOT, "dist-store", "record");
const ID = app.extensionId;

const demo = await readFile(path.join(ASSETS, "demo.html"));
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(demo);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Fake Drive for the Share shot (the e2e build points Share at 127.0.0.1:47123).
const drive = http.createServer(async (req, res) => {
  req.resume();
  await new Promise((r) => req.on("end", r));
  const u = new URL(req.url, "http://x");
  const json = (s, o, h = {}) => (res.writeHead(s, { "Content-Type": "application/json", ...h }), res.end(o === undefined ? "" : JSON.stringify(o)));
  if (u.pathname.startsWith("/session/")) return json(200, { id: "f" });
  if (u.pathname === "/drive/v3/files" && req.method === "GET") return json(200, { files: [] });
  if (u.pathname === "/drive/v3/files") return json(200, { id: "d" });
  if (u.pathname === "/upload/drive/v3/files") return json(200, {}, { Location: "http://127.0.0.1:47123/session/1" });
  if (u.pathname.endsWith("/permissions")) return json(200, { id: "p" });
  return json(200, { webViewLink: "https://drive.google.com/file/d/1aB2cD3eF4/view" });
});
await new Promise((r) => drive.listen(47123, "127.0.0.1", r));

const ctx = await chromium.launchPersistentContext("", {
  channel: process.env.E2E_CHANNEL || "chromium", // msedge where Smart App Control blocks Chromium
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: "light",
  acceptDownloads: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--use-fake-device-for-media-stream", "--auto-accept-camera-and-microphone-capture", "--auto-accept-this-tab-capture", `--allowlisted-extension-id=${ID}`, "--autoplay-policy=no-user-gesture-required"],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent("serviceworker");
const call = (type, msg = {}) => sw.evaluate(([t, m]) => self.neatTest.handlers[t](m, { id: chrome.runtime.id }), [type, msg]);
const phase = async (want, ms = 60_000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 200))) if ((await sw.evaluate(() => self.neatTest.getState())).phase === want) return;
  throw new Error(`no ${want}`);
};
const page = ctx.pages()[0] || (await ctx.newPage());
const ui = page.locator("neat-record-ui");

async function popupShot(stateObj, { pro = false } = {}) {
  await sw.evaluate(async ([st, key]) => {
    await self.neatTest.setState(st, { replace: true });
    if (key) await chrome.storage.sync.set({ licence: key });
    else await chrome.storage.sync.remove("licence");
  }, [stateObj, pro ? await signLicence(privateJwk, { product: app.licenceProduct }) : null]);
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 344, height: 448 });
  await p.goto(`chrome-extension://${ID}/popup.html`);
  await p.locator("body.ready").waitFor();
  await p.waitForTimeout(300);
  const record = await p.locator("#record").boundingBox().catch(() => null);
  const buf = await p.screenshot();
  await p.close();
  return { buf, record };
}

await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: "box", mic: false, sound: true, quality: "better" } })); // Mic off: the default
const popupIdle = await popupShot({ phase: "idle" });

await page.goto(base);
const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith(u)).id, base);
// ② mid-drag on the real overlay
await call("start", { tabId });
await phase("choosing");
await ui.locator(".select").waitFor();
await page.mouse.move(64, 150);
await page.mouse.down();
await page.mouse.move(500, 380, { steps: 10 });
await page.mouse.move(800, 590, { steps: 10 });
await page.waitForTimeout(200);
const shotDrag = await page.screenshot();
await page.mouse.up();
await phase("recording");
await page.waitForTimeout(2600);
const shotRec = await page.screenshot();
const stopBox = await ui.locator('[data-act="stop"]').boundingBox();
await ui.locator('[data-act="stop"]').click();
await phase("done");
await page.waitForTimeout(300);

// Pro: share for real (to the local fake Drive) and capture the card with the link.
await call("dismiss");
const key = await signLicence(privateJwk, { product: app.licenceProduct });
await sw.evaluate((k) => chrome.storage.sync.set({ licence: k }), key);
await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: "tab", mic: true, sound: true, quality: "better", clicks: false, camera: false, countdown: false } }));
await page.goto(base);
await call("start", { tabId });
await phase("recording");
await page.waitForTimeout(2500);
await call("stop");
await phase("done");
await ui.locator('[data-act="share"]').click();
for (let i = 0; i < 100 && !(await sw.evaluate(() => self.neatTest.getState())).link; i++) await page.waitForTimeout(200);
await page.waitForTimeout(400);
const shotShared = await page.screenshot();
const proCardShareBox = await ui.locator('[data-act="share"]').boundingBox();
await call("dismiss");

await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: "box", mic: false, sound: true, quality: "better" } })); // Mic off: the default
const popupPro = await popupShot({ phase: "idle" }, { pro: true });
await ctx.close();
await drive.close();

// ---------------------------------------------------------------- composing: arrows, frames
const browser = await chromium.launch();
const comp = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const dataUrl = (buf, type = "image/png") => `data:${type};base64,${buf.toString("base64")}`;
const icon = await readFile(path.join(ROOT, "apps", "record", "icons", "icon-128.png"));

/** An arrow from `from` to `to` (CSS px of the 1280×800 canvas), accent with a white halo, plus a ring at the target. */
function arrow(from, to, ring = 30) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const tip = { x: to.x - Math.cos(ang) * (ring + 8), y: to.y - Math.sin(ang) * (ring + 8) };
  const head = (s) => [tip.x - Math.cos(ang - 0.5) * s, tip.y - Math.sin(ang - 0.5) * s, tip.x - Math.cos(ang + 0.5) * s, tip.y - Math.sin(ang + 0.5) * s];
  const [ax, ay, bx, by] = head(30);
  const mid = { x: (from.x + tip.x) / 2 + Math.sin(ang) * 40, y: (from.y + tip.y) / 2 - Math.cos(ang) * 40 };
  const line = `M${from.x} ${from.y} Q${mid.x} ${mid.y} ${tip.x} ${tip.y}`;
  return `<g fill="none" stroke-linecap="round" stroke-linejoin="round">
<circle cx="${to.x}" cy="${to.y}" r="${ring}" stroke="#fff" stroke-width="12"/><circle cx="${to.x}" cy="${to.y}" r="${ring}" stroke="#d6363c" stroke-width="6"/>
<path d="${line}" stroke="#fff" stroke-width="18"/><path d="M${ax} ${ay} L${tip.x} ${tip.y} L${bx} ${by}" stroke="#fff" stroke-width="18"/>
<path d="${line}" stroke="#d6363c" stroke-width="10"/><path d="M${ax} ${ay} L${tip.x} ${tip.y} L${bx} ${by}" stroke="#d6363c" stroke-width="10"/></g>`;
}

/** An arrow to a rounded frame drawn around `box` ({x, y, width, height}), so the button's word stays readable. */
function arrowToBox(from, box, pad = 10) {
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const hw = box.width / 2 + pad;
  const hh = box.height / 2 + pad;
  const dx = from.x - c.x;
  const dy = from.y - c.y;
  const t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  const edge = Math.hypot(dx * t, dy * t);
  const frame = `<rect x="${c.x - hw}" y="${c.y - hh}" width="${hw * 2}" height="${hh * 2}" rx="14" fill="none" stroke="#fff" stroke-width="12"/><rect x="${c.x - hw}" y="${c.y - hh}" width="${hw * 2}" height="${hh * 2}" rx="14" fill="none" stroke="#d6363c" stroke-width="6"/>`;
  // arrow() with an invisible ring of the frame's size: its tip stops just outside the frame.
  return frame + arrow(from, c, edge).replace(/<circle[^>]*\/>/g, "");
}

async function render(html, file, { w = 1280, h = 800 } = {}) {
  await comp.setViewportSize({ width: w, height: h });
  await comp.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS.replaceAll(":host, :root", ":root")}*{box-sizing:border-box}html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:var(--font);color-scheme:light}</style></head><body>${html}</body></html>`);
  await comp.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
  const buf = await comp.screenshot();
  if (file) await writeFile(file, buf);
  return buf;
}
const full = (buf) => `<img src="${dataUrl(buf)}" style="position:absolute;inset:0;width:1280px;height:800px">`;
const svgLayer = (inner) => `<svg width="1280" height="800" style="position:absolute;inset:0">${inner}</svg>`;

// A plain toolbar strip (drawn) with the real icon, and the real panel under it.
function withToolbar(popupBuf, target) {
  return `<div style="position:absolute;inset:0;background:#e9eaee"></div>
<div style="position:absolute;left:0;right:0;top:0;height:56px;background:#fff;border-bottom:1px solid #dcdde2;display:flex;align-items:center;gap:12px;padding:0 20px">
<div style="flex:1;height:36px;border-radius:999px;background:#f1f2f5;display:flex;align-items:center;padding:0 18px;color:#62626d;font-size:15px">wayfare.example/trips/lakes</div>
<div style="width:36px;height:36px;border-radius:8px;display:grid;place-items:center;background:${target === "icon" ? "#fde8e7" : "transparent"}"><img src="${dataUrl(icon)}" style="width:22px;height:22px"></div>
<div style="width:30px;height:30px;border-radius:50%;background:#d9dbe1"></div></div>
<div style="position:absolute;right:56px;top:64px;width:344px;height:448px;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff"><img src="${dataUrl(popupBuf)}" style="width:344px;height:448px;display:block"></div>`;
}
// Positions in the 1280×800 composite.
const ICON_AT = { x: 1280 - 20 - 30 - 12 - 18, y: 28 };
const POP = { x: 1280 - 56 - 344, y: 64 };

const helpDir = DOCS;
const steps = [];
// ① Click the icon
await render(withToolbar(popupIdle.buf, "icon") + svgLayer(arrow({ x: 640, y: 150 }, ICON_AT, 26)), path.join(helpDir, "help-1-icon.png"));
steps.push({ title: `Click the ${app.productName} icon`, text: `It's at the top right of your browser. If you can't see it, click the puzzle piece and pin ${esc(app.productName)}.`, img: "help-1-icon.png", alt: "The extension's icon in the browser's toolbar, with its panel open" });
// ② Pick a way, press Record (the panel closes)
const recAt = { x: POP.x + popupIdle.record.x + popupIdle.record.width / 2, y: POP.y + popupIdle.record.y + popupIdle.record.height / 2 };
await render(withToolbar(popupIdle.buf, "") + svgLayer(arrow({ x: 380, y: 520 }, recAt, 56)), path.join(helpDir, "help-2-record.png"));
steps.push({ title: "Pick a way. Press Record.", text: "Pick <b>Draw a box</b>, <b>Screen</b>, <b>Window</b> or <b>This page</b>. Then press the big red button. The panel closes.", img: "help-2-record.png", alt: "The panel with an arrow pointing at the big round Record button" });
// ③ Draw the box (Screen and Window: Chrome asks what to share instead)
await render(full(shotDrag) + svgLayer(arrow({ x: 1090, y: 700 }, { x: 800, y: 590 }, 28)), path.join(helpDir, "help-3-draw.png"));
steps.push({ title: "Draw your box", text: "Press and hold on the page. Move to make a box. Let go. Recording starts now. Changed your mind? Press <b>Esc</b>.<br>Picked Screen or Window? Your browser asks what to share. Click it, then <b>Share</b>.<br>Want the computer's sound with Screen? First turn on <b>Share system audio</b> in that window (in Edge it says <b>Share with system audio</b>, and the button then reads <b>Share with Audio</b>).", img: "help-3-draw.png", alt: "A box being dragged over part of a web page; the rest is darker" });
// ④ Press Stop
await render(full(shotRec) + svgLayer(arrow({ x: 1050, y: 760 }, { x: stopBox.x + stopBox.width / 2, y: stopBox.y + stopBox.height / 2 }, 34)), path.join(helpDir, "help-4-stop.png"));
steps.push({ title: "Press Stop. Your video is in Downloads.", text: `Press <b>Stop</b> on the little bar. Your video is in your <b>Downloads</b> folder.<br>Recording This page, the Screen or a Window? There is no bar. Click the ${esc(app.productName)} icon, then press <b>Stop</b>.`, img: "help-4-stop.png", alt: "The small recording bar with a timer and a Stop button, next to the box" });
// ⑤ Press Share
await render(full(shotShared) + svgLayer(arrowToBox({ x: 600, y: 420 }, proCardShareBox)), path.join(helpDir, "help-5-share.png"));
steps.push({ title: "Press Share", text: `On the “Saved” card. Your video goes to your own Google Drive and you get a link.<br>Closed the card? Click the ${esc(app.productName)} icon, then <b>Last recording</b>.`, img: "help-5-share.png", alt: "The Saved card with Show, Share, Trim and GIF buttons" });
// ⑥ Click Allow once — drawn (Google's real window can't be captured without a live sign-in)
const allowHtml = `<div style="position:absolute;inset:0;background:#e9eaee"></div>
<div style="position:absolute;left:340px;top:90px;width:600px;height:600px;background:#fff;border-radius:20px;box-shadow:0 20px 60px rgba(0,0,0,.25);padding:44px 48px;font:18px/1.5 var(--font);color:#1f1f1f">
<div style="display:flex;align-items:center;gap:14px;font-size:16px;color:#5f6368"><div style="width:36px;height:36px;border-radius:50%;background:#e8eaed"></div>Sign in with your Google account</div>
<h3 style="font-size:28px;font-weight:500;margin:36px 0 16px;line-height:1.25">${esc(app.productName)} wants to access your Google Account</h3>
<p style="margin:0 0 12px;color:#444">This will allow ${esc(app.productName)} to:</p>
<div style="display:flex;gap:14px;align-items:center;padding:16px 0;border-top:1px solid #e8eaed;border-bottom:1px solid #e8eaed"><div style="width:36px;height:36px;border-radius:8px;background:#e8f0fe;display:grid;place-items:center">${svg("folder", 22, "#1a73e8")}</div><div>See, edit, create and delete only the specific Google Drive files you use with this app</div></div>
<div style="position:absolute;right:48px;bottom:44px;display:flex;gap:12px"><span style="padding:10px 24px;border-radius:999px;color:#1a73e8;font-weight:600">Cancel</span><span id="allow" style="padding:10px 28px;border-radius:999px;background:#1a73e8;color:#fff;font-weight:600">Allow</span></div></div>
<div style="position:absolute;left:24px;bottom:20px;padding:6px 12px;border-radius:999px;background:rgba(0,0,0,.55);color:#fff;font:600 13px var(--font)">Drawing — Google's window looks like this</div>`;
await render(allowHtml, null);
await render(allowHtml + svgLayer(arrowToBox({ x: 1150, y: 380 }, await comp.locator("#allow").boundingBox())), path.join(helpDir, "help-6-allow.png"));
steps.push({ title: "Click Allow — only the first time", text: `Google may ask you to sign in first. Then it asks once if ${esc(app.productName)} may put files in your Drive. It can only see the files it makes, nothing else. Anyone you give the link to can watch the video.`, img: "help-6-allow.png", alt: "A drawing of Google's permission window with an arrow at Allow" });
// ⑦ Press Copy — the real panel, captured by the e2e run (tests/e2e-record/pro.spec.js "Last recording")
const copyShot = path.join(ROOT, "test-results", "help-shots", "panel-link-ready.png");
const copyAt = JSON.parse(await readFile(copyShot.replace(/\.png$/, ".json"), "utf8").catch(() => {
  throw new Error(`${path.relative(ROOT, copyShot)} is missing: run the Record e2e first (E2E_CHANNEL=msedge npx playwright test --project=record-e2e)`);
})).copy;
const copyBox = { x: POP.x + copyAt.x, y: POP.y + copyAt.y, width: copyAt.width, height: copyAt.height };
await render(withToolbar(await readFile(copyShot), "") + svgLayer(arrowToBox({ x: 300, y: 560 }, copyBox)), path.join(helpDir, "help-7-copy.png"));
steps.push({ title: "Press Copy", text: "It says <b>Link ready</b>. Press <b>Copy</b>. Now the link is copied. (Often it is copied for you already.)", img: "help-7-copy.png", alt: "The panel's Saved card saying Link ready, with an arrow at the Copy button" });
// ⑧ Paste the link — a real page with the copied link pasted into a message box
const chat = await render(`<div style="position:absolute;inset:0;background:#f4f5f8"></div><div style="position:absolute;left:240px;top:120px;width:800px;height:560px;background:#fff;border-radius:20px;box-shadow:0 12px 40px rgba(0,0,0,.12);padding:32px;font:18px/1.5 var(--font)">
<div style="display:flex;gap:12px;align-items:center;margin-bottom:24px"><div style="width:44px;height:44px;border-radius:50%;background:#2f6fde;color:#fff;display:grid;place-items:center;font-weight:700">A</div><b>Alex</b></div>
<div style="background:#eef1f7;border-radius:16px;padding:14px 18px;max-width:460px">Can you show me how the trip planner works?</div>
<div id="pasted" style="margin:16px 0 0 auto;background:#d6363c;color:#fff;border-radius:16px;padding:14px 18px;max-width:520px;word-break:break-all">Here you go: https://drive.google.com/file/d/1aB2cD3eF4/view</div>
<div style="position:absolute;left:32px;right:32px;bottom:32px;height:60px;border:2px solid #d6363c;border-radius:14px;display:flex;align-items:center;padding:0 18px;color:#62626d">Write a message…</div></div>`, null);
const pastedBox = await comp.locator("#pasted").boundingBox();
await render(full(chat) + svgLayer(arrowToBox({ x: 230, y: 420 }, pastedBox)), path.join(helpDir, "help-8-paste.png"));
steps.push({ title: "Paste the link anywhere", text: "Paste it in an email, a chat or a document (<b>Ctrl+V</b>, or <b>⌘V</b> on a Mac). Anyone with the link can watch.", img: "help-8-paste.png", alt: "A chat message with the Drive link pasted in" });
await writeFile(path.join(DOCS, "help.html"), help(steps));

// ---------------------------------------------------------------- poster → docs + store screenshot 4
const posterBuf = await render(posterHtml().replace("ICON", dataUrl(icon)).replace(/^<!doctype html><html><head>/, "<html><head>"), path.join(DOCS, "poster.png"));
await writeFile(path.join(SHOTS, "4-free-vs-pro.png"), posterBuf);

// ---------------------------------------------------------------- store screenshots (1280×800)
function frame(title, sub, inner, { dark = false } = {}) {
  return `<div style="position:absolute;inset:0;background:${dark ? "linear-gradient(160deg,#1d1d22,#121214)" : "linear-gradient(160deg,#ffffff,#f3f3f6)"}"></div>
<div style="position:absolute;left:64px;top:52px;right:64px;display:flex;align-items:center;gap:14px;font:700 20px var(--font);color:${dark ? "#f3f3f5" : "#111114"}"><img src="${dataUrl(icon)}" style="width:34px;height:34px;border-radius:8px">${esc(app.productName)}</div>
<div style="position:absolute;left:64px;top:104px;right:64px;font:800 46px/1.1 var(--font);letter-spacing:-.02em;color:${dark ? "#fff" : "#111114"}">${esc(title)}</div>
<div style="position:absolute;left:64px;top:166px;right:64px;font:500 22px/1.4 var(--font);color:${dark ? "#a1a1ab" : "#62626d"}">${esc(sub)}</div>${inner}`;
}
const shot = (buf, x, y, w, h) => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.22)"><img src="${dataUrl(buf)}" style="width:100%;height:100%;display:block;object-fit:cover;object-position:top"></div>`;
await render(frame("Press Record. Draw a box.", "Only what's in the box goes in the video. Or record your Screen, a Window or This page.", shot(shotDrag, 192, 218, 896, 560)), path.join(SHOTS, "1-draw-a-box.png"));
await render(
  frame(
    "One click. No account.",
    "Pick what to record, microphone and sound, quality. That's it.",
    `<div style="position:absolute;left:120px;top:250px;width:560px;font:500 24px/1.6 var(--font);color:#111114"><div>✓ Free forever, unlimited recordings</div><div>✓ Saved straight to Downloads (MP4)</div><div>✓ Good · Better · Best, in plain words</div><div>✓ Stays on your computer unless you Share</div></div>
<div style="position:absolute;right:150px;top:240px;width:344px;height:448px;border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.25)"><img src="${dataUrl(popupPro.buf)}" style="width:344px;height:448px;display:block"></div>`,
  ),
  path.join(SHOTS, "2-panel.png"),
);
await render(frame("A tiny bar. Never in your way.", "It sits outside your box. Stop when you're done — the video is already saved.", shot(shotRec, 192, 218, 896, 560)), path.join(SHOTS, "3-recording.png"));
await render(frame("Saved. Share with a link.", "Pro: one press uploads to your own Google Drive and copies the link.", shot(shotShared, 192, 218, 896, 560)), path.join(SHOTS, "5-saved-and-shared.png"));

// Promo tile 440×280 and marquee 1400×560
await render(
  `<div style="position:absolute;inset:0;background:linear-gradient(160deg,#1d1d22,#121214)"></div><div style="position:absolute;left:32px;top:40px;display:flex;align-items:center;gap:14px;font:800 30px var(--font);color:#fff"><img src="${dataUrl(icon)}" style="width:60px;height:60px;border-radius:14px">${esc(app.productName)}</div>
<div style="position:absolute;left:32px;top:132px;right:24px;font:700 26px/1.25 var(--font);color:#fff">Draw a box.<br>Press Record.</div><div style="position:absolute;left:32px;bottom:28px;font:500 16px var(--font);color:#a1a1ab">No watermark · No account</div>`,
  path.join(OUT, "promo-small-440x280.png"),
  { w: 440, h: 280 },
);
await render(
  `<div style="position:absolute;inset:0;background:linear-gradient(160deg,#1d1d22,#121214)"></div><div style="position:absolute;left:72px;top:150px;display:flex;align-items:center;gap:18px;font:800 40px var(--font);color:#fff"><img src="${dataUrl(icon)}" style="width:80px;height:80px;border-radius:18px">${esc(app.productName)}</div>
<div style="position:absolute;left:72px;top:270px;width:520px;font:800 48px/1.1 var(--font);letter-spacing:-.02em;color:#fff">Press Record. Draw a box.</div><div style="position:absolute;left:72px;top:400px;font:500 22px var(--font);color:#a1a1ab">No watermark · No account · Saved on your computer</div>
<div style="position:absolute;right:60px;top:60px;width:700px;height:440px;border-radius:16px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.5)"><img src="${dataUrl(shotDrag)}" style="width:100%;height:100%;object-fit:cover;object-position:top"></div>`,
  path.join(OUT, "marquee-1400x560.png"),
  { w: 1400, h: 560 },
);
await browser.close();
server.close();
await rm(path.join(ROOT, "dist-store"), { recursive: true, force: true });
console.log(`store kit written to ${path.relative(ROOT, OUT)}; pages to ${path.relative(ROOT, DOCS)}`);
