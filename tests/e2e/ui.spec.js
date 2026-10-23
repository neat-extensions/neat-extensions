// Popup and options page: live toggling, allow list, diagnostics, review card, dark mode.
import { test, expect, URLS, RULES, openYouTube, countVisible, coversRules, shot } from "./helpers.js";

test("popup toggles change the open YouTube page live, without reload", async ({ context, page, extensionId }) => {
  coversRules("watch-sidebar", "watch-comments");
  await openYouTube(page, URLS.watch, "watch");
  let reloads = 0;
  page.on("load", () => reloads++);
  expect(await countVisible(page, "ytd-watch-flexy #related")).toBe(1);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  // every rule and feature has a toggle
  for (const r of RULES.rules) await expect(popup.locator(`input[data-id="${r.id}"]`)).toHaveCount(1);
  await expect(popup.locator('input[data-id="shorts-redirect"]')).toBeChecked();
  await popup.locator('label[for="t-watch-sidebar"]').click();
  await popup.locator('label[for="t-watch-comments"]').click();
  await expect(popup.locator('input[data-id="watch-sidebar"]')).toBeChecked();

  await expect.poll(() => countVisible(page, "ytd-watch-flexy #related")).toBe(0);
  expect(await page.locator("ytd-comments#comments").evaluate((e) => getComputedStyle(e).display)).toBe("none");

  // master off: everything comes back, still live
  await popup.locator("#master").click();
  await expect(popup.locator("#status")).toHaveText("Paused");
  await expect.poll(() => countVisible(page, "ytd-watch-flexy #related")).toBe(1);
  expect(reloads).toBe(0);
});

test("popup review card: only after 10 distinct days, and never again once dismissed", async ({ context, worker, extensionId }) => {
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const popup = await context.newPage();
  await worker.evaluate(() => chrome.storage.local.set(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`act:2026-01-${String(i + 1).padStart(2, "0")}`, 1]))));
  await popup.goto(popupUrl);
  await expect(popup.locator("#groups .row").first()).toBeVisible();
  await expect(popup.locator("#review-card")).toHaveCount(0);

  await worker.evaluate(() => chrome.storage.local.set({ "act:2026-01-10": 1 }));
  await popup.reload();
  await expect(popup.locator("#review-card")).toBeVisible();
  await expect(popup.locator("#review-card a")).toHaveAttribute("href", /chromewebstore\.google\.com\/detail\/.+\/reviews/);
  await shot(popup, "popup-review");
  await popup.getByRole("button", { name: "Dismiss" }).click();
  await expect(popup.locator("#review-card")).toHaveCount(0);

  await worker.evaluate(() => chrome.storage.local.set({ "act:2026-02-01": 1, "act:2026-02-02": 1 }));
  await popup.reload();
  await expect(popup.locator("#groups .row").first()).toBeVisible();
  await expect(popup.locator("#review-card")).toHaveCount(0);
  const store = await worker.evaluate(() => chrome.storage.local.get("review"));
  expect(store.review).toEqual({ eligible: true, dismissed: true });
});

test("options page: toggles, allow list, shortcut, diagnostics, about", async ({ context, worker, extensionId }) => {
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(opts.locator("#groups input[data-id]")).toHaveCount(RULES.rules.length + 2);
  await expect(opts.locator("#shortcut")).toHaveText(/Alt\+Shift\+Y|Not set/);
  await expect(opts.locator("#about .trust li")).toHaveText(["No account.", "Nothing leaves your browser.", "Open source."]);
  await expect(opts.locator("#more li")).not.toHaveCount(0);
  await expect(opts.locator("#d-rules")).toContainText(RULES.version);
  await expect(opts.locator("#d-status")).toContainText("not-configured");

  await opts.locator("#allow-input").fill("https://www.youtube.com/@LinusTechTips/videos");
  await opts.getByRole("button", { name: "Add" }).click();
  await expect(opts.locator("#allow-list .chip")).toHaveText(["@linustechtips×"]);
  await opts.locator("#allow-input").fill("<img src=x onerror=alert(1)>");
  await opts.getByRole("button", { name: "Add" }).click();
  await expect(opts.locator("#allow-error")).not.toBeEmpty();
  const { settings } = await worker.evaluate(() => chrome.storage.local.get("settings"));
  expect(settings.allowlist).toEqual(["@linustechtips"]);

  await opts.getByRole("button", { name: "Remove @linustechtips" }).click();
  await expect(opts.locator("#allow-list .chip")).toHaveCount(0);

  // toggling in options is reflected in an open popup
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await opts.locator('label[for="t-watch-comments"]').click();
  await expect(popup.locator('input[data-id="watch-comments"]')).toBeChecked();

  // diagnostics copy
  await worker.evaluate(() => chrome.storage.local.set({ diagnostics: [{ kind: "broken", ruleId: "shorts-search", build: "2.2026", page: "search", at: "2026-10-23T00:00:00Z", count: 1 }] }));
  await expect(opts.locator("#d-log")).toContainText("shorts-search");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `chrome-extension://${extensionId}` }).catch(() => {});
  await opts.locator("#d-copy").click();
  await expect(opts.locator("#d-copied")).toHaveText(/Copied|Copy failed/);
});

test("light and dark themes both render with readable contrast", async ({ context, extensionId }) => {
  const p = await context.newPage();
  for (const scheme of ["light", "dark"]) {
    await p.emulateMedia({ colorScheme: scheme });
    for (const pageName of ["popup", "options"]) {
      await p.goto(`chrome-extension://${extensionId}/${pageName}.html`);
      await expect(p.locator("#groups .row").first()).toBeVisible();
      const { bg, fg } = await p.evaluate(() => {
        const s = getComputedStyle(document.body);
        return { bg: s.backgroundColor, fg: s.color };
      });
      const lum = (c) => {
        const [r, g, b] = c.match(/\d+/g).map(Number).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [a, b] = [lum(bg), lum(fg)].sort((x, y) => y - x);
      expect((a + 0.05) / (b + 0.05), `${pageName} ${scheme}`).toBeGreaterThan(7);
      expect(lum(bg) < 0.1, `${pageName} ${scheme} background`).toBe(scheme === "dark");
    }
  }
});

test("no extension-page console errors and no network requests from extension pages", async ({ context, extensionId }) => {
  const errors = [];
  const requests = [];
  const p = await context.newPage();
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => !r.url().startsWith("chrome-extension://") && requests.push(r.url()));
  for (const name of ["popup", "options"]) {
    await p.goto(`chrome-extension://${extensionId}/${name}.html`);
    await expect(p.locator("#groups .row").first()).toBeVisible();
  }
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});
