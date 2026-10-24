// Pro: a licence key pasted on the Pro page unlocks everything and is kept in
// chrome.storage.sync; pause/resume, trim, GIF and Share produce correct output.
import { test, expect, launch, worker, startServer, startFakeDrive, setSettings, tabIdOf, call, waitPhase, lastDownload, probe, testLicence, unlockPro, state, ID } from "./helpers.js";
import { readFileSync } from "node:fs";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { inspectMp4 } from "../../apps/record/src/lib/mp4.js";
import { inspectGif } from "../../apps/record/src/lib/gif.js";

let server;
test.beforeAll(async () => (server = await startServer()));
test.afterAll(async () => server.close());

test("a licence key unlocks Pro and is stored in sync storage", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`chrome-extension://${ID}/pro.html`);
    await expect(page.getByText("Already bought? Paste your key")).toBeVisible();
    // A key for another product is refused with a plain sentence.
    await page.locator("#key").fill(await testLicence("tabs"));
    await page.locator("#unlock").click();
    await expect(page.locator("#key-status")).toContainText("different");
    // The real one, pasted with line breaks around it, unlocks.
    const key = await testLicence();
    await page.locator("#key").fill(`\n  ${key.slice(0, 50)}\n${key.slice(50)}  \n`);
    await page.locator("#unlock").click();
    await expect(page.getByText("Pro is on. Thank you!")).toBeVisible();
    expect(await sw.evaluate(() => chrome.storage.sync.get("licence"))).toEqual({ licence: key });
    // The panel shows Pro on and no locks.
    await page.goto(`chrome-extension://${ID}/popup.html`);
    await expect(page.locator("#pro")).toHaveText("Pro ✓");
    expect(await page.locator(".lock").count()).toBe(0);
  } finally {
    await ctx.close();
  }
});

test("pause/resume, trim and GIF give correct files", async () => {
  test.setTimeout(240_000);
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    await unlockPro(sw);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: true, mic: true, quality: "better", countdown: true, clicks: true, camera: true });

    expect((await call(sw, "start", { tabId })).ok).toBe(true);
    // 3-2-1 countdown first, on the page.
    await waitPhase(sw, "countdown", 10_000);
    await expect(page.locator("neat-record-ui").locator(".count")).toBeVisible();
    await waitPhase(sw, "recording", 10_000);
    await expect(page.locator("neat-record-ui").locator(".count")).toHaveCount(0);
    // Webcam bubble and click highlights are on the page while recording — and the camera really plays.
    await expect(page.locator("neat-record-ui").locator(".cam iframe")).toBeAttached();
    const camFrame = page.frames().find((f) => f.url().includes("/camera.html"));
    expect(camFrame, "the camera page loaded inside the bubble").toBeTruthy();
    await expect.poll(() => camFrame.evaluate(() => document.getElementById("v").readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await page.mouse.click(700, 500);
    await expect(page.locator("neat-record-ui").locator(".ripple")).toHaveCount(1);
    // Recorded time: 4 s, a 5-s pause (not recorded), then 4 s more → about 8 s.
    await page.waitForTimeout(4_000);
    await call(sw, "pause"); // the panel's Pause (tab recordings have no bar on the page)
    await expect.poll(async () => (await state(sw)).paused).toBe(true);
    await page.waitForTimeout(5_000);
    await call(sw, "resume");
    await expect.poll(async () => (await state(sw)).paused).toBe(false);
    await page.waitForTimeout(4_000);
    await call(sw, "stop");
    const st = await waitPhase(sw, "done", 60_000);
    expect(st.note).toBeNull(); // no limit line for Pro
    const d = await lastDownload(sw);
    const full = await inspectMp4(bufferSource(readFileSync(d.filename)));
    expect(full.durationMs).toBeGreaterThan(7_000);
    expect(full.durationMs).toBeLessThan(9_800);

    // Trim to 2 s → 6 s with the real panel.
    const card = page.locator("neat-record-ui").locator(".card");
    await card.locator('[data-act="trim"]').click();
    await card.locator('input[aria-label="Start"]').fill("2");
    await card.locator('input[aria-label="End"]').fill("6");
    await expect(card.locator(".trim-label")).toHaveText("Keep 0:02 to 0:06");
    await card.getByText("Save trimmed copy").click();
    await expect.poll(async () => (await state(sw)).toast, { timeout: 60_000 }).toBe("Trimmed copy saved to Downloads");
    const t = await lastDownload(sw);
    expect(t.id).not.toBe(d.id);
    const trimmed = await inspectMp4(bufferSource(readFileSync(t.filename)));
    expect(trimmed.durationMs).toBeGreaterThan(3_000);
    expect(trimmed.durationMs).toBeLessThan(5_200);
    expect((await state(sw)).last.filename).toMatch(/\(trimmed\)\.mp4$/);
    const tp = await probe(page, server, t.filename);
    expect(Math.abs(tp.seekedTo - tp.target)).toBeLessThan(0.6);

    // GIF of the trimmed clip.
    await page.goto(`${server.base}/busy.html`);
    await call(sw, "gif", {});
    await expect.poll(async () => (await state(sw)).toast, { timeout: 120_000 }).toBe("GIF saved to Downloads");
    const g = await lastDownload(sw);
    expect(g.mime).toBe("image/gif");
    const gi = inspectGif(new Uint8Array(readFileSync(g.filename)));
    expect(gi.width).toBe(640);
    expect(gi.height).toBe(360);
    expect(gi.frames).toBeGreaterThan(30);
    expect(gi.durationMs).toBeGreaterThan(3_000);
    expect(gi.durationMs).toBeLessThan(5_300);
  } finally {
    await ctx.close();
  }
});

test("Share uploads to Drive, makes a link and copies it", async () => {
  test.setTimeout(180_000);
  const drive = await startFakeDrive();
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    await unlockPro(sw);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.base });
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false, countdown: false, camera: false, clicks: false });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await page.waitForTimeout(3_000);
    await call(sw, "stop");
    await waitPhase(sw, "done");
    const size = (await lastDownload(sw)).fileSize;
    await page.locator("neat-record-ui").locator('[data-act="share"]').click();
    await expect.poll(async () => (await state(sw)).toast, { timeout: 60_000 }).toBe("Link copied — anyone with the link can watch");
    const st = await state(sw);
    expect(st.link).toBe("https://drive.google.com/file/d/file1/view?usp=drivesdk");
    await expect(page.locator("neat-record-ui").locator(".link")).toHaveValue(st.link);
    await expect(page.locator("neat-record-ui").locator(".toast")).toHaveText("Link copied — anyone with the link can watch");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(st.link);
    expect(drive.seen.bytes).toBe(size);
    expect([...drive.seen.auth]).toEqual(["Bearer test-token"]);
    expect(drive.seen.files[0]).toMatchObject({ parents: ["folder1"], mimeType: "video/mp4" });
    expect(drive.seen.permissions).toEqual([{ role: "reader", type: "anyone" }]);
  } finally {
    await ctx.close();
    await drive.close();
  }
});

test("Share while offline says so, cleanly", async () => {
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
    await waitPhase(sw, "done");
    // No fake Drive running: the connection is refused, like being offline.
    await call(sw, "share");
    await expect.poll(async () => (await state(sw)).toast, { timeout: 30_000 }).toMatch(/offline/i);
    const st = await state(sw);
    expect(st.phase).toBe("done");
    expect(st.job).toBeNull();
    // The recording is still there for another try.
    expect(
      await sw.evaluate(async () => {
        const out = [];
        for await (const k of (await navigator.storage.getDirectory()).keys()) out.push(k);
        return out;
      }),
    ).toEqual([st.last.opfsName]);
  } finally {
    await ctx.close();
  }
});

test("free: the page card has no Pro buttons; the panel shows them locked and opens the Pro page", async () => {
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await page.waitForTimeout(1_500);
    await call(sw, "stop");
    await waitPhase(sw, "done");
    const card = page.locator("neat-record-ui").locator(".card");
    await expect(card.locator('[data-act="share"]')).toHaveCount(0);
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 344, height: 448 });
    await panel.goto(`chrome-extension://${ID}/popup.html`);
    await expect(panel.locator("#done-actions .lock")).toHaveCount(3); // Share, Trim, GIF
    const [pro] = await Promise.all([ctx.waitForEvent("page"), panel.getByRole("button", { name: /Share \(Pro/ }).click()]);
    await expect(pro).toHaveURL(new RegExp(`chrome-extension://${ID}/pro.html`));
    expect((await call(sw, "share")).error).toBe("pro");
  } finally {
    await ctx.close();
  }
});
