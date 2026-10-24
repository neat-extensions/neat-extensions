// 15-second recordings in each of the four modes land in Downloads, play,
// have the right duration and seek. Draw-a-box is dragged with the real mouse
// on the real overlay, at DPR 2, and the output is checked pixel by pixel.
import { test, expect, launch, worker, startServer, setSettings, tabIdOf, call, waitPhase, lastDownload, probe, recordFor, state } from "./helpers.js";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { inspectMp4 } from "../../apps/record/src/lib/mp4.js";
import { inspectWebm } from "../../apps/record/src/lib/webm.js";
import { readFileSync, statSync } from "node:fs";

const SECONDS = Number(process.env.RECORD_SECONDS || 15);
let server;
test.beforeAll(async () => (server = await startServer()));
test.afterAll(async () => server.close());

async function checkFile(page, d, { seconds = SECONDS, w, h } = {}) {
  expect(d, "a completed download").toBeTruthy();
  expect(d.byExtensionId).toBeTruthy();
  expect(d.mime).toMatch(/^video\/(mp4|webm)$/);
  const bytes = readFileSync(d.filename);
  expect(bytes.length).toBe(statSync(d.filename).size);
  const box = d.mime === "video/mp4" ? await inspectMp4(bufferSource(bytes)) : await inspectWebm(bufferSource(bytes));
  // The container itself says how long it is (players read this).
  expect(box.durationMs).toBeGreaterThan((seconds - 1.5) * 1000);
  expect(box.durationMs).toBeLessThan((seconds + 2) * 1000);
  const p = await probe(page, server, d.filename);
  expect(Number.isFinite(p.duration)).toBe(true);
  expect(p.duration).toBeGreaterThan(seconds - 1.5);
  expect(p.duration).toBeLessThan(seconds + 2);
  expect(Math.abs(p.seekedTo - p.target)).toBeLessThan(0.6);
  if (w) expect([p.width, p.height]).toEqual([w, h]);
  return { p, box, bytes: bytes.length };
}

for (const mode of ["tab", "box"]) {
  test(`${mode}: ${SECONDS}-second recording is saved, plays and seeks`, async () => {
    const dpr = mode === "box" ? 2 : 1;
    const ctx = await launch({ deviceScaleFactor: dpr });
    try {
      const sw = await worker(ctx);
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(`${server.base}/busy.html${mode === "box" ? "?plain" : ""}`);
      const tabId = await tabIdOf(sw, server.base);
      await setSettings(sw, { mode, sound: true, mic: true, quality: "better" });
      if (mode === "tab") {
        const { download, st } = await recordFor(sw, { tabId, ms: SECONDS * 1000 });
        expect(st.last.filename).toMatch(/^Neat Record \d{4}-\d{2}-\d{2} at \d{2}\.\d{2}\.\d{2}\.mp4$/);
        const r = await checkFile(page, download, { w: 1280, h: 720 });
        test.info().annotations.push({ type: "result", description: JSON.stringify({ mode, bytes: r.bytes, duration: r.p.duration, seekMs: r.p.seekMs }) });
        return;
      }
      // Draw a box with the mouse over the green target (400×240 CSS px at 200,120), border included.
      const r = await call(sw, "start", { tabId });
      expect(r).toMatchObject({ ok: true, close: true });
      await waitPhase(sw, "choosing");
      await page.locator("neat-record-ui").locator(".select").waitFor();
      await page.mouse.move(200, 120);
      await page.mouse.down();
      await page.mouse.move(400, 240, { steps: 5 });
      await page.mouse.move(600, 360, { steps: 5 });
      await page.mouse.up();
      await waitPhase(sw, "recording", 30_000);
      // The bar sits outside the box, and the frame is outside it too.
      const bar = await page.locator("neat-record-ui").locator(".bar").boundingBox();
      expect(bar.y >= 360 || bar.y + bar.height <= 120 || bar.x >= 600 || bar.x + bar.width <= 200).toBe(true);
      // Free: Stop and the time (with the limit), nothing to buy.
      await expect(page.locator("neat-record-ui").locator('.bar [data-act="pause"]')).toHaveCount(0);
      await expect(page.locator("neat-record-ui").locator(".bar .time")).toContainText("/ 10:00");
      await page.waitForTimeout(SECONDS * 1000);
      // Stop with the real button on the page.
      await page.locator("neat-record-ui").locator('[data-act="stop"]').click();
      await waitPhase(sw, "done", 60_000);
      // The card shows up, the bar is gone.
      await expect(page.locator("neat-record-ui").locator(".card")).toBeVisible();
      const d = await lastDownload(sw);
      const res = await checkFile(page, d, { w: 800, h: 480 });
      // Pixel-accurate at DPR 2: the blue border is at the very edge, the inside is green.
      const [r0, g0, b0] = res.p.px.tl;
      expect(b0, `top-left ${res.p.px.tl}`).toBeGreaterThan(150);
      expect(r0 + g0).toBeLessThan(120);
      const [r1, g1, b1] = res.p.px.centre;
      expect(g1, `centre ${res.p.px.centre}`).toBeGreaterThan(180);
      expect(r1 + b1).toBeLessThan(120);
      const [, gi] = res.p.px.inner;
      expect(gi, `8px in ${res.p.px.inner}`).toBeGreaterThan(180); // the 4-CSS-px border is 8 device px: pixel 8 is the first green one
    } finally {
      await ctx.close();
    }
  });
}

for (const mode of ["window", "screen"]) {
  test(`${mode}: ${SECONDS}-second recording is saved, plays and seeks`, async () => {
    const ctx = await launch({ display: true });
    try {
      const sw = await worker(ctx);
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(`${server.base}/busy.html`);
      const tabId = await tabIdOf(sw, server.base);
      const { download, st } = await recordFor(sw, { tabId, ms: SECONDS * 1000, settings: { mode, sound: true, mic: true, quality: "better" } });
      expect(st.mode).toBe(mode);
      await checkFile(page, download);
      expect((await state(sw)).phase).toBe("done");
    } finally {
      await ctx.close();
    }
  });
}
