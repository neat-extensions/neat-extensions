// Nothing of Neat Record's own controls ends up in a video (the Stop bar's shadow, the 3-2-1 disk, the
// panel during a Screen recording), and an extension update keeps the last recording reachable.
import { test, expect, launch, worker, startServer, setSettings, tabIdOf, call, waitPhase, lastDownload, state, unlockPro, ID } from "./helpers.js";
import { readFileSync } from "node:fs";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { inspectMp4 } from "../../apps/record/src/lib/mp4.js";

let server;
test.beforeAll(async () => (server = await startServer()));
test.afterAll(async () => server.close());

/** Brightness (min and mean of r,g,b averages) of a region of the frame at `t` s; region in fractions of the frame. */
async function frameStats(page, file, t, region) {
  return page.evaluate(
    async ({ src, t, region }) => {
      const v = document.createElement("video");
      v.muted = true;
      v.src = src;
      document.body.append(v);
      await new Promise((r) => (v.onloadeddata = r));
      await new Promise((r) => {
        v.onseeked = r;
        v.currentTime = t;
      });
      const c = new OffscreenCanvas(v.videoWidth, v.videoHeight);
      const g = c.getContext("2d");
      for (let i = 0; i < 30; i++) {
        g.drawImage(v, 0, 0);
        if (g.getImageData(0, 0, 1, 1).data[3] > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const x = Math.floor(region.x * c.width);
      const y = Math.floor(region.y * c.height);
      const w = Math.max(1, Math.floor(region.w * c.width));
      const h = Math.max(1, Math.floor(region.h * c.height));
      const d = g.getImageData(x, y, w, h).data;
      let min = 255;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        min = Math.min(min, l);
        sum += l;
      }
      return { min: Math.round(min), mean: Math.round(sum / (d.length / 4)), size: [v.videoWidth, v.videoHeight] };
    },
    { src: `${server.base}/file?p=${encodeURIComponent(file)}`, t, region },
  );
}

test("Draw a box: the Stop bar just below the box leaves no shadow in the video", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/still.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "box", sound: false, mic: false, quality: "better" });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "choosing");
    await page.locator("neat-record-ui").locator(".select").waitFor();
    // A box over the plain white margin left of the text; the bar lands 12 px under its bottom edge.
    await page.mouse.move(20, 100);
    await page.mouse.down();
    await page.mouse.move(120, 250, { steps: 5 });
    await page.mouse.move(230, 400, { steps: 5 });
    await page.mouse.up();
    await waitPhase(sw, "recording", 30_000);
    const bar = await page.locator("neat-record-ui").locator(".bar").boundingBox();
    expect(bar.y - 400).toBeLessThan(20); // right under the box: where a shadow would reach in
    await page.waitForTimeout(2_500);
    await page.locator("neat-record-ui").locator('[data-act="stop"]').click();
    await waitPhase(sw, "done", 60_000);
    const d = await lastDownload(sw);
    const bottom = await frameStats(page, d.filename, 1.5, { x: 0, y: 0.97, w: 1, h: 0.03 });
    const middle = await frameStats(page, d.filename, 1.5, { x: 0.1, y: 0.4, w: 0.8, h: 0.2 });
    console.log("  box bottom rows:", JSON.stringify(bottom), "middle:", JSON.stringify(middle));
    expect(middle.min).toBeGreaterThan(240); // the white page
    expect(bottom.min).toBeGreaterThanOrEqual(middle.min - 1); // no darker band at the edge next to the bar (the old shadow: 252 vs 255)
  } finally {
    await ctx.close();
  }
});

test("3-2-1: the very first frame of the video has no trace of the countdown", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    await unlockPro(sw);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/still.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false, quality: "better", countdown: true, camera: false, clicks: false });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "countdown", 10_000);
    await waitPhase(sw, "recording", 10_000);
    await page.waitForTimeout(2_500);
    await call(sw, "stop");
    await waitPhase(sw, "done", 60_000);
    const d = await lastDownload(sw);
    // The countdown disk is 152 CSS px, dark, in the middle of the page.
    const area = { x: 0.4, y: 0.35, w: 0.2, h: 0.3 };
    const first = await frameStats(page, d.filename, 0, area);
    const later = await frameStats(page, d.filename, 2, area);
    console.log("  centre, first frame:", JSON.stringify(first), "at 2 s:", JSON.stringify(later));
    // The same page as later on (some text, mostly white): a dark disk there would pull the average far down.
    expect(Math.abs(first.mean - later.mean)).toBeLessThanOrEqual(2);
    expect(first.mean).toBeGreaterThan(230);
  } finally {
    await ctx.close();
  }
});

test("Screen: the panel open during a recording isn't in the video — held while open, resumed when it closes", async () => {
  const ctx = await launch({ display: true });
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "screen", sound: false, mic: false });

    // Opened and closed again without stopping: recording carries on.
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording", 30_000);
    await page.waitForTimeout(2_000);
    let panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${ID}/popup.html`);
    await expect.poll(async () => (await state(sw)).held).toBe(true);
    await expect(panel.locator("#live-hint")).toHaveText("Paused while this panel is open, so the panel isn't in your video.");
    // The panel's clock stops too (it shows what's in the video).
    const t1 = await panel.locator("#live-time").textContent();
    await panel.waitForTimeout(1_600);
    expect(await panel.locator("#live-time").textContent()).toBe(t1);
    await panel.waitForTimeout(1_000);
    await panel.close();
    await expect.poll(async () => (await state(sw)).held).toBe(false);
    await page.waitForTimeout(2_000);

    // Opened again and Stop pressed there: the time it was open is not in the file.
    panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${ID}/popup.html`);
    await expect.poll(async () => (await state(sw)).held).toBe(true);
    await panel.waitForTimeout(2_000);
    await panel.locator("#stop").click();
    await waitPhase(sw, "done", 60_000);
    const info = await inspectMp4(bufferSource(readFileSync((await lastDownload(sw)).filename)));
    console.log("  screen with panel opened twice:", info.durationMs, "ms");
    // About 4 s recorded (2 + 2); the panel was open about 3 s more.
    expect(info.durationMs).toBeGreaterThan(3_000);
    expect(info.durationMs).toBeLessThan(5_500);
  } finally {
    await ctx.close();
  }
});

test("an extension update keeps the last recording: Last recording still opens it; the old card says what happened", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    await unlockPro(sw);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false, countdown: false, camera: false, clicks: false });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await page.waitForTimeout(2_000);
    await call(sw, "stop");
    const before = await waitPhase(sw, "done");
    await sw.evaluate(() => chrome.runtime.reload()); // what an update does
    const sw2 = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
    await expect.poll(async () => (await state(sw2)).phase, { timeout: 15_000 }).toBe("done");
    expect((await state(sw2)).last.opfsName).toBe(before.last.opfsName);
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${ID}/popup.html`);
    await expect(panel.locator("#last")).toBeVisible();
    await panel.locator("#last").click();
    await expect(panel.getByRole("button", { name: "Trim" })).toBeEnabled();
    // The card still on the page from before the update: pressing it explains instead of vanishing.
    await page.bringToFront();
    await page.locator("neat-record-ui").locator('[data-act="gif"]').click();
    await expect(page.locator("neat-record-ui").locator(".orphan")).toHaveText(/Neat Record was updated\. Your video is in Downloads/);
  } finally {
    await ctx.close();
  }
});

test("Draw a box over the whole page (Enter): no Stop bar on the page, so none in the video; the panel stops it", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/still.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "box", sound: false, mic: false, quality: "better" });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "choosing");
    await page.locator("neat-record-ui").locator(".select").waitFor();
    await page.keyboard.press("Enter"); // "Enter: whole page"
    await waitPhase(sw, "recording", 30_000);
    await expect(page.locator("neat-record-ui").locator(".bar")).toHaveCount(0);
    await expect.poll(async () => (await state(sw)).barless).toBe(true);
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${ID}/popup.html`);
    await expect(panel.locator("#live-hint")).toHaveText("Your box fills the page, so there's no bar on it: stop here.");
    await page.bringToFront();
    await page.waitForTimeout(2_500);
    await panel.locator("#stop").click();
    await waitPhase(sw, "done", 60_000);
    const d = await lastDownload(sw);
    // Bottom-left, where the bar used to sit: the white page, nothing else, in the middle and near the end.
    for (const t of [1, 2]) {
      const corner = await frameStats(page, d.filename, t, { x: 0, y: 0.85, w: 0.35, h: 0.15 });
      expect(corner.min, `bottom-left at ${t} s`).toBeGreaterThan(240);
    }
  } finally {
    await ctx.close();
  }
});

test("the Stop bar can't be dragged onto the box", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/still.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "box", sound: false, mic: false });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "choosing");
    await page.locator("neat-record-ui").locator(".select").waitFor();
    await page.mouse.move(300, 100);
    await page.mouse.down();
    await page.mouse.move(700, 400, { steps: 6 });
    await page.mouse.up();
    await waitPhase(sw, "recording", 30_000);
    const grip = page.locator("neat-record-ui").locator(".bar .grip");
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(500, 250, { steps: 10 }); // into the middle of the box
    await page.mouse.up();
    const bar = await page.locator("neat-record-ui").locator(".bar").boundingBox();
    const inside = bar.x < 700 + 12 && bar.x + bar.width > 300 - 12 && bar.y < 400 + 12 && bar.y + bar.height > 100 - 12;
    expect(inside).toBe(false);
    await call(sw, "stop");
    await waitPhase(sw, "done", 60_000);
  } finally {
    await ctx.close();
  }
});

test("trimming twice: two different names, and the card shows the one it saved", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    await unlockPro(sw);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false, countdown: false, camera: false, clicks: false });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await page.waitForTimeout(6_000);
    await call(sw, "stop");
    const st0 = await waitPhase(sw, "done");
    const base = st0.last.filename.replace(/\.mp4$/, "");
    await call(sw, "trim", { startMs: 1000, endMs: 5000 });
    await expect.poll(async () => (await state(sw)).toast, { timeout: 60_000 }).toBe("Trimmed copy saved to Downloads");
    expect((await state(sw)).last.filename).toBe(`${base} (trimmed).mp4`);
    await sw.evaluate(() => self.neatTest.setState({ toast: null }));
    await call(sw, "trim", { startMs: 1000, endMs: 3000 });
    await expect.poll(async () => (await state(sw)).toast, { timeout: 60_000 }).toBe("Trimmed copy saved to Downloads");
    expect((await state(sw)).last.filename).toBe(`${base} (trimmed 2).mp4`);
  } finally {
    await ctx.close();
  }
});
