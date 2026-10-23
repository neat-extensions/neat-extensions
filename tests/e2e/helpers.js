// Shared e2e fixtures: Chromium with the unpacked extension, consent-free
// YouTube navigation, and visibility oracles that do NOT reuse the engine's
// own locators (so a stale selector cannot make a test pass vacuously).
import { test as base, chromium, expect } from "@playwright/test";
import path from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import { BRAND_SLUG } from "../../brand.config.js";

export const MARK = `data-${BRAND_SLUG}-hide`;
export const STYLE = `style[data-${BRAND_SLUG}]`;
// Set by the canary when a real rules host exists; the extension may request exactly these.
export const ALLOWED_EXT_REQUESTS = process.env.E2E_RULES_URL ? [process.env.E2E_RULES_URL, `${process.env.E2E_RULES_URL}.sig`] : [];

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const EXT_DIR = path.join(ROOT, "dist-test", "youtube");
export const RULES = JSON.parse(readFileSync(path.join(ROOT, "apps", "youtube", "rules", "rules.json"), "utf8"));
export const SHOTS_DIR = path.join(ROOT, "test-results", "screenshots");
mkdirSync(SHOTS_DIR, { recursive: true });

export const URLS = {
  home: "https://www.youtube.com/",
  search: "https://www.youtube.com/results?search_query=news",
  watch: "https://www.youtube.com/watch?v=jNQXAC9IVRw", // "Me at the zoo": stable, short, owner @jawed
  channel: "https://www.youtube.com/@LinusTechTips", // channel home with a Shorts shelf
  channelShorts: "https://www.youtube.com/@MrBeast/shorts", // used to find a live Shorts id
};

const CONSENT_COOKIE = { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/", secure: true, sameSite: "Lax" };

// Lets context.on("request") see requests made by the extension's service worker.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

export async function launch({ extension = true, extDir = EXT_DIR, viewport = { width: 1400, height: 900 }, extraArgs = [], deviceScaleFactor } = {}) {
  const args = extension ? [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...extraArgs] : extraArgs;
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED,
    viewport,
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
    locale: "en-US",
    args: [...args, "--autoplay-policy=no-user-gesture-required"],
  });
  // Pre-answer YouTube's EU consent ("reject all") so no dialog blocks the page.
  await context.addCookies([CONSENT_COOKIE]);
  return context;
}

export async function extensionWorker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  return sw;
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const context = await launch();
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => use(await extensionWorker(context)),
  extensionId: async ({ worker }, use) => use(new URL(worker.url()).host),
  page: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },
});
export { expect };

/** Dismiss the consent dialog/interstitial if YouTube shows one despite the cookie. */
export async function handleConsent(page) {
  if (/consent\.(youtube|google)\./.test(page.url())) {
    const btn = page.getByRole("button", { name: /reject all/i }).first();
    await btn.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForURL(/www\.youtube\.com/, { timeout: 20_000 }).catch(() => {});
  }
  const dialog = page.locator("ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog:has(button[aria-label*='Reject'])");
  if (await dialog.first().isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /reject all/i }).first().click().catch(() => {});
  }
}

const READY = {
  home: "ytd-browse[page-subtype='home']",
  search: "ytd-search ytd-item-section-renderer",
  watch: "ytd-watch-flexy #movie_player",
  channel: "ytd-browse[page-subtype='channels'] ytd-tabbed-page-header, ytd-browse[page-subtype='channels'] #tabsContent, ytd-browse[page-subtype='channels'] yt-tab-group-shape",
};

/** Navigate, clear consent, wait for YouTube's app to hydrate, then nudge lazy content. */
export async function openYouTube(page, url, kind, { scroll = true } = {}) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await handleConsent(page);
  await page.waitForSelector("ytd-app", { state: "attached", timeout: 30_000 });
  if (READY[kind]) await page.waitForSelector(READY[kind], { state: "attached", timeout: 30_000 });
  await page.waitForLoadState("load").catch(() => {});
  if (scroll) {
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(800);
    }
    await page.mouse.wheel(0, -10_000);
  }
  await page.waitForTimeout(2000); // let the engine's frame + idle passes settle
}

/** Count elements matching `selector` that a user could see (rendered, non-zero box). */
export async function countVisible(page, selector, { text } = {}) {
  return page.evaluate(
    ({ selector, text }) => {
      let n = 0;
      for (const el of document.querySelectorAll(selector)) {
        if (text && el.textContent.replace(/\s+/g, " ").trim() !== text) continue;
        if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1) n++;
      }
      return n;
    },
    { selector, text },
  );
}

export async function countAttached(page, selector) {
  return page.evaluate((s) => document.querySelectorAll(s).length, selector);
}

/** Set extension storage from the service worker (same thing the popup does). */
export async function setSettings(worker, patch) {
  await worker.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    const next = { enabled: true, allowlist: [], ...settings, ...patch, toggles: { ...(settings.toggles || {}), ...(patch.toggles || {}) } };
    await chrome.storage.local.set({ settings: next });
  }, patch);
}

export function allRulesOn() {
  return Object.fromEntries(RULES.rules.map((r) => [r.id, true]));
}

/** Record which rule a test covers, for the canary failure summary. */
export function coversRules(...ids) {
  for (const id of ids) base.info().annotations.push({ type: "rule", description: id });
}

export async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) }).catch(() => {});
}

/**
 * A fresh logged-out profile gets an empty Home ("try searching"). Watching a
 * couple of videos first makes YouTube fill Home with a normal feed, Shorts included.
 */
export async function warmUpHome(page) {
  for (const v of ["jNQXAC9IVRw", "dQw4w9WgXcQ"]) await openYouTube(page, `https://www.youtube.com/watch?v=${v}`, "watch", { scroll: false });
}
