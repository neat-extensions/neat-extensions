// Pro: a licence key pasted on the Pro page unlocks everything and is kept in
// chrome.storage.sync; pause/resume, trim, GIF and Share produce correct output.
import { test, expect, launch, worker, startServer, startFakeDrive, setSettings, tabIdOf, call, waitPhase, lastDownload, probe, testLicence, unlockPro, state, ID, RESULTS } from "./helpers.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
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
    // The panel is open when the recording ends, so it shows the "Saved" card.
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 344, height: 448 });
    await panel.goto(`chrome-extension://${ID}/popup.html`);
    await page.waitForTimeout(1_500);
    await call(sw, "stop");
    await waitPhase(sw, "done");
    const card = page.locator("neat-record-ui").locator(".card");
    await expect(card.locator('[data-act="share"]')).toHaveCount(0);
    await expect(panel.locator("#done-actions .lock")).toHaveCount(3); // Share, Trim, GIF
    const [pro] = await Promise.all([ctx.waitForEvent("page"), panel.getByRole("button", { name: /Share \(Pro/ }).click()]);
    await expect(pro).toHaveURL(new RegExp(`chrome-extension://${ID}/pro.html`));
    expect((await call(sw, "share")).error).toBe("pro");
  } finally {
    await ctx.close();
  }
});

/** A solid red fake camera (Y4M, YUV 4:2:0): any overlay text in the bubble shows up as white pixels. */
function redCamera() {
  const file = path.join(RESULTS, "red-camera.y4m");
  const w = 320;
  const h = 320;
  const frame = Buffer.concat([Buffer.from("FRAME\n"), Buffer.alloc(w * h, 76), Buffer.alloc((w * h) / 4, 85), Buffer.alloc((w * h) / 4, 255)]);
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`), frame, frame]));
  return file;
}

/** Share of near-white pixels and of red pixels inside the middle of a circle, from RGBA data. */
function bubbleStats(px) {
  let white = 0;
  let red = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) white++;
    if (px[i] > 150 && px[i + 1] < 90 && px[i + 2] < 90) red++;
  }
  const n = px.length / 4;
  return { white: white / n, red: red / n };
}

test("camera bubble: when the camera works, no 'Camera blocked' text — on the page or in the video", async () => {
  test.setTimeout(120_000);
  const ctx = await launch({ extraArgs: [`--use-file-for-fake-video-capture=${redCamera()}`] });
  try {
    const sw = await worker(ctx);
    await unlockPro(sw);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false, quality: "better", countdown: false, clicks: false, camera: true });
    expect((await call(sw, "start", { tabId })).ok).toBe(true);
    await waitPhase(sw, "recording", 15_000);
    const bubble = page.locator("neat-record-ui").locator(".cam");
    await expect(bubble).toBeVisible();
    const camFrame = page.frames().find((f) => f.url().includes("/camera.html"));
    await expect.poll(() => camFrame.evaluate(() => document.getElementById("v").readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    await expect(camFrame.locator("#msg")).toBeHidden();

    // The detector works: forcing the message on makes white text appear in the bubble.
    const box = await bubble.boundingBox();
    const inner = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.3, width: box.width * 0.5, height: box.height * 0.4 };
    const shotPx = async () => {
      const png = await page.screenshot({ clip: inner });
      return page.evaluate(async (b64) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height);
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0);
        return [...g.getImageData(0, 0, img.width, img.height).data];
      }, png.toString("base64"));
    };
    const clean = bubbleStats(await shotPx());
    await camFrame.evaluate(() => (document.getElementById("msg").hidden = false));
    await expect(camFrame.locator("#msg")).toBeVisible();
    // Wait for the bubble to repaint with the text before measuring it.
    let withText = bubbleStats(await shotPx());
    for (let i = 0; i < 20 && withText.white <= clean.white + 0.02; i++) {
      await page.waitForTimeout(100);
      withText = bubbleStats(await shotPx());
    }
    await camFrame.evaluate(() => (document.getElementById("msg").hidden = true));
    expect(clean.red).toBeGreaterThan(0.6);
    expect(withText.white).toBeGreaterThan(clean.white + 0.02);

    await page.waitForTimeout(3_000);
    await call(sw, "stop");
    await waitPhase(sw, "done", 60_000);
    const d = await lastDownload(sw);
    const vp = page.viewportSize();
    // A recorded frame 1 s before the end (the bubble is up by then), the same middle part of it, scaled to the video's size.
    const px = await page.evaluate(
      async ({ src, inner, vp }) => {
        const v = document.createElement("video");
        v.muted = true;
        v.src = src;
        document.body.append(v);
        await new Promise((r) => (v.onloadeddata = r));
        await new Promise((r) => {
          v.onseeked = r;
          v.currentTime = Math.max(0, v.duration - 1);
        });
        const sx = v.videoWidth / vp.width;
        const sy = v.videoHeight / vp.height;
        const c = new OffscreenCanvas(Math.round(inner.width * sx), Math.round(inner.height * sy));
        const g = c.getContext("2d");
        // Under load the seeked frame can arrive a moment after "seeked": draw until there is a picture.
        for (let i = 0; i < 30; i++) {
          g.clearRect(0, 0, c.width, c.height);
          g.drawImage(v, inner.x * sx, inner.y * sy, inner.width * sx, inner.height * sy, 0, 0, c.width, c.height);
          if (g.getImageData(0, 0, 1, 1).data[3] > 0) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        // The whole frame too, kept as evidence if the check fails.
        const full = new OffscreenCanvas(v.videoWidth, v.videoHeight);
        full.getContext("2d").drawImage(v, 0, 0);
        const blob = await full.convertToBlob({ type: "image/png" });
        const b64 = (
          await new Promise((r) => {
            const fr = new FileReader();
            fr.onload = () => r(fr.result);
            fr.readAsDataURL(blob);
          })
        ).split(",")[1];
        return { data: [...g.getImageData(0, 0, c.width, c.height).data], b64, at: v.currentTime, duration: v.duration };
      },
      { src: `${server.base}/file?p=${encodeURIComponent(d.filename)}`, inner, vp },
    );
    const rec = bubbleStats(px.data);
    if (rec.red <= 0.5) {
      writeFileSync(path.join(RESULTS, "camera-frame-failed.png"), Buffer.from(px.b64, "base64"));
      console.log("  camera frame check failed:", JSON.stringify({ ...rec, at: px.at, duration: px.duration, inner, vp }));
    }
    expect(rec.red, "the camera picture is in the video").toBeGreaterThan(0.5);
    expect(rec.white, "no overlay text in the video").toBeLessThan(clean.white + 0.01);
  } finally {
    await ctx.close();
  }
});

test("Share without Chrome's own sign-in (Edge, Brave): Google's web sign-in, then upload; a cancelled sign-in says so", async () => {
  test.setTimeout(180_000);
  const drive = await startFakeDrive();
  const ctx = await launch();
  try {
    const sw = await worker(ctx);
    await unlockPro(sw);
    await sw.evaluate(() => chrome.storage.local.set({ testWebSignIn: true }));
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false, countdown: false, camera: false, clicks: false });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await page.waitForTimeout(2_000);
    await call(sw, "stop");
    await waitPhase(sw, "done");
    expect((await call(sw, "share")).ok).toBe(true);
    await expect.poll(async () => (await state(sw)).link, { timeout: 60_000 }).toBe("https://drive.google.com/file/d/file1/view?usp=drivesdk");
    expect(drive.seen.signIns).toHaveLength(1);
    expect(drive.seen.signIns[0]).toMatchObject({
      client_id: "test-web-client.apps.googleusercontent.com",
      response_type: "token",
      redirect_uri: `https://${ID}.chromiumapp.org/`,
      scope: "https://www.googleapis.com/auth/drive.file",
    });
    expect([...drive.seen.auth]).toEqual(["Bearer test-token"]);
    // Share again: the token is reused, no second sign-in.
    expect((await call(sw, "share")).ok).toBe(true);
    await expect.poll(async () => (await state(sw)).job, { timeout: 60_000 }).toBeNull();
    expect(drive.seen.signIns).toHaveLength(1);
    // Sign-in refused or closed: a plain message, nothing uploaded.
    await sw.evaluate(() => chrome.storage.session.remove("webToken"));
    drive.seen.denySignIn = true;
    const before = drive.seen.files.length;
    expect((await call(sw, "share")).ok).toBe(true);
    await expect.poll(async () => (await state(sw)).toast, { timeout: 60_000 }).toBe("Google sign-in didn't finish. Press Share to try again.");
    expect(drive.seen.files.length).toBe(before);
  } finally {
    await ctx.close();
    await drive.close();
  }
});

// Also takes the help page's "Press Copy" picture: the real panel, captured here (scripts/store-record.mjs uses it).
export const HELP_SHOTS = path.join(RESULTS, "help-shots");

test("closing the Saved card keeps the last recording: the panel's Last recording reopens it, and Share there says Link ready — press Copy", async () => {
  test.setTimeout(180_000);
  const drive = await startFakeDrive();
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
    await page.waitForTimeout(3_000);
    await call(sw, "stop");
    await waitPhase(sw, "done");
    // The user closes the card on the page.
    await page.locator("neat-record-ui").locator('[data-act="dismiss"]').click();
    await expect(page.locator("neat-record-ui").locator(".card")).toHaveCount(0);
    const st = await state(sw);
    expect(st.phase).toBe("done");
    expect(await sw.evaluate(async () => { const out = []; for await (const n of (await navigator.storage.getDirectory()).keys()) out.push(n); return out; })).toHaveLength(1); // still there for Share/Trim/GIF

    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 344, height: 448 });
    await panel.goto(`chrome-extension://${ID}/popup.html`);
    await expect(panel.locator("#idle")).toBeVisible();
    await expect(panel.locator("#last")).toHaveText(/^Last recording · 0:0\d — open$/);
    await panel.locator("#last").click();
    await expect(panel.locator("#done")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Trim" })).toBeEnabled();
    await expect(panel.getByRole("button", { name: "GIF" })).toBeEnabled(); // a short clip: plain "GIF"
    await panel.getByRole("button", { name: "Share" }).click();
    await expect(panel.locator("#done-toast")).toHaveText("Link ready — press Copy. Anyone with the link can watch.", { timeout: 60_000 });
    await expect(panel.locator("#done-link")).toHaveValue("https://drive.google.com/file/d/file1/view?usp=drivesdk");
    // The help page's picture: this panel, as it is now.
    mkdirSync(HELP_SHOTS, { recursive: true });
    await panel.screenshot({ path: path.join(HELP_SHOTS, "panel-link-ready.png") });
    const copy = await panel.locator("#copy").boundingBox();
    writeFileSync(path.join(HELP_SHOTS, "panel-link-ready.json"), JSON.stringify({ copy }));
    await panel.locator("#copy").click();
    await expect(panel.locator("#done-toast")).toHaveText("Link copied — anyone with the link can watch");
    // Record again: back to the main screen, the last recording still one click away.
    await panel.locator("#new").click();
    await expect(panel.locator("#idle")).toBeVisible();
    await expect(panel.locator("#last")).toBeVisible();
  } finally {
    await ctx.close();
    await drive.close();
  }
});
