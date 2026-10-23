// Live end-to-end checks against real https://www.youtube.com pages with the
// unpacked extension loaded. Oracles are independent of rules.json: they look
// for what a user would see (links to /shorts/, a "Shorts" tab, …).
import { test, expect, URLS, RULES, openYouTube, warmUpHome, countVisible, countAttached, setSettings, allRulesOn, coversRules, shot } from "./helpers.js";

const MARK = "data-neat-hide";

/** Collect console errors and page errors that come from the extension, and every request it makes. */
function watchExtension(context, page, extensionId) {
  const errors = [];
  const requests = [];
  const fromExt = (s) => typeof s === "string" && s.includes(`chrome-extension://${extensionId}`);
  const hook = (p) => {
    p.on("console", (m) => {
      if (m.type() === "error" && (fromExt(m.location().url) || fromExt(m.text()))) errors.push(m.text());
    });
    p.on("pageerror", (e) => {
      if (fromExt(e.stack)) errors.push(e.message);
    });
  };
  hook(page);
  context.on("page", hook);
  // Requests from the extension's service worker. (Content scripts make none; the build's source scan enforces that.)
  context.on("request", (r) => {
    const sw = r.serviceWorker();
    if (sw && fromExt(sw.url())) requests.push(r.url());
  });
  return { errors, requests };
}

/** Note in the report when the live page had nothing to hide (so the pass is not over-claimed). */
async function noteIfVacuous(page, selector, what) {
  const n = await countAttached(page, selector);
  test.info().annotations.push({ type: n ? "targets-present" : "inconclusive", description: `${what}: ${n} target element(s) in DOM` });
  return n;
}

test.describe("default settings", () => {
  test("search: Shorts are hidden, normal results are not", async ({ page, context, extensionId }) => {
    coversRules("shorts-search");
    const ext = watchExtension(context, page, extensionId);
    await openYouTube(page, URLS.search, "search");
    await shot(page, "search");
    await noteIfVacuous(page, 'ytd-search a[href^="/shorts/"]', "Shorts links on search");
    expect(await countVisible(page, 'ytd-search a[href^="/shorts/"]')).toBe(0);
    expect(await countVisible(page, "ytd-search ytm-shorts-lockup-view-model, ytd-search ytm-shorts-lockup-view-model-v2, ytd-search ytd-reel-shelf-renderer")).toBe(0);
    expect(await countVisible(page, "ytd-search ytd-video-renderer")).toBeGreaterThan(3);
    expect(ext.errors).toEqual([]);
    expect(ext.requests).toEqual([]);
  });

  test("home: Shorts sidebar entry and Shorts shelf hidden, feed untouched", async ({ page, context, extensionId }) => {
    coversRules("shorts-sidebar", "shorts-home", "home-feed");
    const ext = watchExtension(context, page, extensionId);
    await warmUpHome(page);
    await openYouTube(page, URLS.home, "home");
    await shot(page, "home");
    expect(await countAttached(page, "ytd-guide-entry-renderer")).toBeGreaterThan(3);
    expect(await countVisible(page, "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer", { text: "Shorts" })).toBe(0);
    expect(await countVisible(page, "ytd-guide-entry-renderer", { text: "Subscriptions" })).toBe(1); // neighbours untouched
    await noteIfVacuous(page, 'ytd-browse[page-subtype="home"] a[href^="/shorts/"]', "Shorts on Home");
    expect(await countVisible(page, 'ytd-browse[page-subtype="home"] a[href^="/shorts/"]')).toBe(0);
    // home-feed is OFF by default: the feed container must be shown
    expect(await countVisible(page, 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer')).toBe(1);
    expect(ext.errors).toEqual([]);
    expect(ext.requests).toEqual([]);
  });

  test("channel: Shorts tab and Shorts shelf hidden, other tabs untouched", async ({ page, context, extensionId }) => {
    coversRules("shorts-channel");
    const ext = watchExtension(context, page, extensionId);
    await openYouTube(page, URLS.channel, "channel");
    await shot(page, "channel");
    await noteIfVacuous(page, 'ytd-browse[page-subtype="channels"] a[href^="/shorts/"]', "Shorts on channel home");
    expect(await countAttached(page, "yt-tab-shape")).toBeGreaterThan(2);
    expect(await countVisible(page, "yt-tab-shape", { text: "Shorts" })).toBe(0);
    expect(await countVisible(page, "yt-tab-shape", { text: "Videos" })).toBe(1);
    expect(await countVisible(page, 'ytd-browse[page-subtype="channels"] a[href^="/shorts/"]')).toBe(0);
    expect(ext.errors).toEqual([]);
    expect(ext.requests).toEqual([]);
  });

  test("watch: Shorts suggestions hidden; OFF rules leave the page unchanged", async ({ page, context, extensionId }) => {
    coversRules("shorts-watch", "watch-comments", "watch-sidebar", "watch-endscreen");
    const ext = watchExtension(context, page, extensionId);
    await openYouTube(page, URLS.watch, "watch");
    await shot(page, "watch");
    expect(await countVisible(page, 'ytd-watch-flexy a[href^="/shorts/"]')).toBe(0);
    expect(await countVisible(page, "ytd-watch-flexy #related")).toBe(1);
    expect(await page.locator("ytd-comments#comments").evaluate((e) => getComputedStyle(e).display)).not.toBe("none");
    // Nothing on the page is marked or styled for OFF rules.
    const off = RULES.rules.filter((r) => !r.default).map((r) => r.id);
    const { marks, css } = await page.evaluate((MARK) => ({ marks: [...document.querySelectorAll(`[${MARK}]`)].map((e) => e.getAttribute(MARK)).join(" "), css: document.querySelector("style[data-neat]").textContent }), MARK);
    for (const id of off) {
      expect(marks.split(" ")).not.toContain(id);
      expect(css).not.toContain(`"${id}"`);
    }
    expect(css).not.toContain("ytd-comments#comments");
    expect(ext.errors).toEqual([]);
    expect(ext.requests).toEqual([]);
  });

  test("/shorts/ URL redirects to the watch page, once, with no loop", async ({ page, context, extensionId }) => {
    coversRules("shorts-redirect");
    const ext = watchExtension(context, page, extensionId);
    await openYouTube(page, URLS.channelShorts, "channel", { scroll: false });
    const href = await page.locator('a[href^="/shorts/"]').first().getAttribute("href", { timeout: 30_000 });
    const id = /\/shorts\/([\w-]{11})/.exec(href)[1];

    const navigations = [];
    page.on("framenavigated", (f) => f === page.mainFrame() && navigations.push(f.url()));
    await page.goto(`https://www.youtube.com/shorts/${id}`, { waitUntil: "domcontentloaded" });
    await page.waitForURL(new RegExp(`/watch\\?v=${id}`), { timeout: 20_000 });
    await page.waitForTimeout(4000);
    await shot(page, "shorts-redirect");
    expect(page.url()).toContain(`/watch?v=${id}`);
    expect(navigations.filter((u) => u.includes("/shorts/")).length).toBeLessThanOrEqual(1);
    expect(navigations.filter((u) => u.includes("/watch")).length).toBe(1);

    // In-app click on a Shorts link (SPA navigation) also lands on the watch page.
    await openYouTube(page, URLS.channelShorts, "channel", { scroll: false });
    await page.locator('a[href^="/shorts/"]').first().click();
    await page.waitForURL(/\/watch\?v=/, { timeout: 20_000 });
    expect(ext.errors).toEqual([]);
    expect(ext.requests).toEqual([]);
  });

  test("self-check finds no broken rules on live pages", async ({ page, worker }) => {
    coversRules(...RULES.rules.filter((r) => r.default).map((r) => r.id));
    for (const [url, kind] of [[URLS.search, "search"], [URLS.channel, "channel"], [URLS.watch, "watch"], [URLS.home, "home"]]) {
      await openYouTube(page, url, kind);
    }
    await page.waitForTimeout(4000); // let the idle-time self-check run
    const { diagnostics = [] } = await worker.evaluate(() => chrome.storage.local.get("diagnostics"));
    const broken = diagnostics.filter((d) => d.kind === "broken");
    test.info().annotations.push({ type: "diagnostics", description: JSON.stringify(diagnostics) });
    expect(broken).toEqual([]);
  });
});

test.describe("every rule on", () => {
  test("watch page: comments, sidebar, end screen hidden; autoplay turned off", async ({ page, worker }) => {
    coversRules("watch-comments", "watch-sidebar", "watch-endscreen", "autoplay-off");
    await setSettings(worker, { toggles: { ...allRulesOn(), "autoplay-off": true } });
    await openYouTube(page, URLS.watch, "watch");
    await shot(page, "watch-all-on");
    expect(await countVisible(page, "ytd-watch-flexy #related, ytd-watch-next-secondary-results-renderer")).toBe(0);
    expect(await countVisible(page, "ytd-comments#comments")).toBe(0);
    expect(await page.locator("ytd-comments#comments").evaluate((e) => getComputedStyle(e).display)).toBe("none");
    expect(await page.locator(".html5-video-player .html5-endscreen").first().evaluate((e) => getComputedStyle(e).display)).toBe("none");
    await expect(page.locator(".ytp-autonav-toggle-button").first()).toHaveAttribute("aria-checked", "false", { timeout: 15_000 });
  });

  test("home: entire feed hidden", async ({ page, worker }) => {
    coversRules("home-feed");
    await setSettings(worker, { toggles: allRulesOn() });
    await openYouTube(page, URLS.home, "home");
    expect(await countVisible(page, 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer')).toBe(0);
    expect(await countVisible(page, "ytd-masthead")).toBe(1); // search box stays
  });

  test("master switch off restores the page", async ({ page, worker }) => {
    coversRules("shorts-search");
    await openYouTube(page, URLS.search, "search");
    const attached = await countAttached(page, 'ytd-search a[href^="/shorts/"]');
    await setSettings(worker, { enabled: false });
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => document.querySelector("style[data-neat]").textContent)).toBe("");
    if (attached) expect(await countVisible(page, 'ytd-search a[href^="/shorts/"]')).toBeGreaterThan(0);
  });
});

test.describe("allow list", () => {
  test("an allowed channel is exempt on its videos and channel page, others are not", async ({ page, worker }) => {
    coversRules("watch-sidebar", "shorts-channel");
    await setSettings(worker, { toggles: { "watch-sidebar": true }, allowlist: ["@jawed", "@linustechtips"] });
    await openYouTube(page, URLS.watch, "watch");
    expect(await countVisible(page, "ytd-watch-flexy #related")).toBe(1);
    await openYouTube(page, URLS.channel, "channel");
    expect(await countVisible(page, "yt-tab-shape", { text: "Shorts" })).toBe(1);

    await setSettings(worker, { allowlist: [] }); // live, no reload
    await page.waitForTimeout(800);
    expect(await countVisible(page, "yt-tab-shape", { text: "Shorts" })).toBe(0);
  });
});
