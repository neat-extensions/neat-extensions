// The panel fits with no scroll bar at 100% zoom, in light and dark, in every
// state, and is usable with the keyboard alone.
import { test, expect, launch, worker, unlockPro, ID, RESULTS } from "./helpers.js";
import path from "node:path";
import app from "../../apps/record/app.config.js";

const STATES = {
  idle: { phase: "idle" },
  recording: { phase: "recording", mode: "tab", startedAt: Date.now() - 83_000, bankedMs: 0, paused: false, injected: true },
  saving: { phase: "saving", mode: "tab" },
  done: { phase: "done", last: { filename: "Neat Record 2026-10-23 at 14.05.32.mp4", durationMs: 83_000, size: 27_400_000, opfsName: "x.mp4" }, toast: "Link copied", link: "https://drive.google.com/file/d/abc/view" },
  error: { phase: "error", toast: "This page can't be recorded. Open a normal web page and try again." },
};

for (const scheme of ["light", "dark"]) {
  for (const pro of [false, true]) {
    test(`popup fits without scrolling — ${scheme}, ${pro ? "Pro" : "free"}, every state`, async () => {
      const ctx = await launch({ viewport: { width: 344, height: 448 }, colorScheme: scheme });
      try {
        const sw = await worker(ctx);
        if (pro) await unlockPro(sw);
        const page = ctx.pages()[0] || (await ctx.newPage());
        for (const [name, st] of Object.entries(STATES)) {
          await sw.evaluate((st) => self.neatTest.setState(st, { replace: true }), st);
          await page.goto(`chrome-extension://${ID}/popup.html`);
          await page.locator("body.ready").waitFor();
          const m = await page.evaluate(() => ({
            sh: document.documentElement.scrollHeight,
            ch: document.documentElement.clientHeight,
            sw: document.documentElement.scrollWidth,
            cw: document.documentElement.clientWidth,
            bodyH: document.body.getBoundingClientRect().height,
            bodyW: document.body.getBoundingClientRect().width,
            bg: getComputedStyle(document.body).backgroundColor,
            overflowing: [...document.querySelectorAll("main:not([hidden]) *")].filter((e) => {
              const r = e.getBoundingClientRect();
              return r.width > 0 && (r.bottom > innerHeight + 0.5 || r.right > innerWidth + 0.5);
            }).length,
          }));
          expect(m.sh, `${name}: scrollHeight <= clientHeight`).toBeLessThanOrEqual(m.ch);
          expect(m.sw, `${name}: no horizontal scroll`).toBeLessThanOrEqual(m.cw);
          expect(m.overflowing, `${name}: nothing spills out`).toBe(0);
          // Same box in every state: zero layout shift between them.
          expect([m.bodyW, m.bodyH]).toEqual([344, 448]);
          expect(m.bg).toBe(scheme === "dark" ? "rgb(24, 24, 27)" : "rgb(255, 255, 255)");
          await page.screenshot({ path: path.join(RESULTS, "record-shots", `popup-${scheme}-${pro ? "pro" : "free"}-${name}.png`) });
        }
      } finally {
        await ctx.close();
      }
    });
  }
}

test("keyboard only: pick a mode with arrows, toggle a switch, reach Record", async () => {
  const ctx = await launch({ viewport: { width: 344, height: 448 } });
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`chrome-extension://${ID}/popup.html`);
    await page.locator("body.ready").waitFor();
    await page.locator('.mode[aria-checked="true"]').focus();
    // Fresh install: Draw a box first and selected; then Screen, Window, This page.
    expect(await page.locator(".mode").evaluateAll((els) => els.map((e) => e.textContent))).toEqual(["Draw a box", "Screen", "Window", "This page"]);
    await expect(page.locator('.mode[data-id="box"]')).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('.mode[data-id="window"]')).toHaveAttribute("aria-checked", "true");
    // Window: no sound to record, so the Sound switch is off and disabled.
    await expect(page.locator('.toggle[data-id="sound"]')).toBeDisabled();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('.mode[data-id="screen"]')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('.toggle[data-id="mic"]')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator('.toggle[data-id="sound"]')).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.locator('.toggle[data-id="sound"]')).toHaveAttribute("aria-pressed", "false");
    for (let i = 0; i < 12 && !(await page.locator("#record").evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("Tab");
    await expect(page.locator("#record")).toBeFocused();
    // A visible focus ring.
    const ring = await page.locator("#record").evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(ring).toBe("solid");
    expect(await sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings)).toMatchObject({ mode: "screen", sound: false });
  } finally {
    await ctx.close();
  }
});

test("free: Pro items show a small lock and open the Pro page, nothing else", async () => {
  const ctx = await launch({ viewport: { width: 344, height: 448 } });
  try {
    await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`chrome-extension://${ID}/popup.html`);
    await page.locator("body.ready").waitFor();
    // Camera, Clicks, 3-2-1, Best.
    expect(await page.locator("#idle .lock").count()).toBe(4);
    await expect(page.locator("#quality-caption")).toHaveText("1080p HD · ~20 MB a minute · Free: up to 10 minutes");
    const [pro] = await Promise.all([ctx.waitForEvent("page"), page.locator('.toggle[data-id="camera"]').click()]);
    await expect(pro).toHaveURL(new RegExp(`chrome-extension://${ID}/pro.html`));
    await expect(pro.getByRole("link", { name: `Get Pro — ${app.price}` })).toHaveAttribute("href", app.buyUrl);
  } finally {
    await ctx.close();
  }
});

test("nothing opens on install, and an idle extension has no recorder running", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(ctx.pages().map((p) => p.url())).toEqual(["about:blank"]);
    expect(await sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
    expect(await sw.evaluate(() => chrome.action.getBadgeText({}))).toBe("");
  } finally {
    await ctx.close();
  }
});
