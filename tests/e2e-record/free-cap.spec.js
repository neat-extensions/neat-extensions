// Free plan: at 10:00 the recording stops cleanly, saves, and shows one quiet
// line — at most once a day. The e2e build runs the limiter 30× faster, so
// 10 minutes of recording are 20 seconds of test.
import { test, expect, launch, worker, startServer, setSettings, tabIdOf, call, waitPhase, lastDownload, probe, state } from "./helpers.js";
import { readFileSync } from "node:fs";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { inspectMp4 } from "../../apps/record/src/lib/mp4.js";

let server;
test.beforeAll(async () => (server = await startServer()));
test.afterAll(async () => server.close());

test("the free 10-minute limit stops, saves cleanly and says so once a day", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: true, mic: false, quality: "better" });

    // Recording 1: runs into the limit on its own (10 "minutes" = 20 s here).
    expect((await call(sw, "start", { tabId })).ok).toBe(true);
    await waitPhase(sw, "recording");
    // Tab recordings have no bar on the page (it would be in the video); the state carries the limit for the panel.
    await expect(page.locator("neat-record-ui").locator(".bar")).toHaveCount(0);
    expect((await sw.evaluate(() => self.neatTest.getState())).limitMs).toBe(600_000);
    const t0 = Date.now();
    const st = await waitPhase(sw, "done", 60_000);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThan(19_000);
    expect(took).toBeLessThan(32_000);
    expect(st.note).toBe("Saved. Pro removes the 10-minute limit");
    // Shown in the page as one quiet line in the saved card — not a popup, no new tab.
    await expect(page.locator("neat-record-ui").locator(".note")).toHaveText("Saved. Pro removes the 10-minute limit");
    expect(ctx.pages().length).toBe(1);
    const d = await lastDownload(sw);
    const info = await inspectMp4(bufferSource(readFileSync(d.filename)));
    expect(info.durationMs).toBeGreaterThan(19_000);
    expect(info.durationMs).toBeLessThan(21_500);
    const p = await probe(page, server, d.filename);
    expect(p.duration).toBeGreaterThan(19);
    expect(Math.abs(p.seekedTo - p.target)).toBeLessThan(0.6);

    // Recording 2, same day: the limit stops it again, the line does not come back.
    await page.goto(`${server.base}/busy.html`);
    await call(sw, "dismiss");
    expect((await call(sw, "start", { tabId })).ok).toBe(true);
    const st2 = await waitPhase(sw, "done", 60_000);
    expect(st2.last.recordedMs).toBeGreaterThanOrEqual(600_000 - 2_000);
    expect(st2.note).toBe("Stopped at 10:00."); // says why, no Pro line the second time
    // Free: the card offers the file and nothing to buy.
    const card = page.locator("neat-record-ui").locator(".card");
    await expect(card.locator('[data-act="show"]')).toBeVisible();
    await expect(card.locator('[data-act="share"], [data-act="trim"], [data-act="gif"]')).toHaveCount(0);
    // Nothing kept in the extension's storage for a free user after saving.
    const files = await sw.evaluate(async () => {
      const out = [];
      for await (const k of (await navigator.storage.getDirectory()).keys()) out.push(k);
      return out;
    });
    expect(files).toEqual([]);
    expect(await sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
    expect((await state(sw)).phase).toBe("done");
  } finally {
    await ctx.close();
  }
});
