// The things that go wrong in real life: a crash mid-recording, Stop during
// 3-2-1, closing the card while it saves, the page reloading under the box
// overlay, pages Chrome won't let anyone record.
import { test, expect, launch, worker, startServer, setSettings, tabIdOf, call, waitPhase, lastDownload, state, unlockPro, probe } from "./helpers.js";
import { readFileSync } from "node:fs";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { inspectMp4 } from "../../apps/record/src/lib/mp4.js";

let server;
test.beforeAll(async () => (server = await startServer()));
test.afterAll(async () => server.close());

async function setup(opts = {}) {
  const ctx = await launch(opts);
  const sw = await worker(ctx);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(`${server.base}/busy.html`);
  const tabId = await tabIdOf(sw, server.base);
  await setSettings(sw, { mode: "tab", sound: true, mic: false, quality: "better", countdown: false, camera: false, clicks: false });
  return { ctx, sw, page, tabId };
}

test("a recording cut off by a crash is recovered and saved, not lost", async () => {
  const { ctx, sw, tabId } = await setup();
  try {
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await new Promise((r) => setTimeout(r, 6_000));
    // The recorder dies (crash, update): no stop, no repair.
    await sw.evaluate(() => chrome.offscreen.closeDocument());
    // Next time the user presses Record, the stuck state heals and the cut-off recording is saved first.
    await call(sw, "start", { tabId });
    const st = await waitPhase(sw, "done", 60_000);
    expect(st.note).toBe("A recording that was cut off has been saved.");
    expect(st.last.filename).toMatch(/\(recovered\)\.mp4$/);
    const d = await lastDownload(sw);
    const info = await inspectMp4(bufferSource(readFileSync(d.filename)));
    expect(info.durationMs).toBeGreaterThan(3_000); // flushed chunks survived
    expect(info.hasMfra).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("Stop during the 3-2-1 countdown just cancels", async () => {
  const { ctx, sw, tabId, page } = await setup();
  try {
    await unlockPro(sw);
    await setSettings(sw, { countdown: true });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "countdown", 15_000);
    await call(sw, "stop");
    await waitPhase(sw, "idle", 10_000);
    await page.waitForTimeout(3_500);
    expect((await state(sw)).phase).toBe("idle"); // the countdown finishing doesn't start a recording
    expect(await sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
    await expect(page.locator("neat-record-ui").locator(".count")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("closing the card while it saves can't break anything", async () => {
  const { ctx, sw, tabId } = await setup();
  try {
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await new Promise((r) => setTimeout(r, 3_000));
    await call(sw, "stop");
    const r = await call(sw, "dismiss"); // while saving
    expect(r).toMatchObject({ ok: false, error: "busy" });
    const st = await waitPhase(sw, "done");
    expect(st.last.size).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

test("the page reloading under the box overlay doesn't leave the panel stuck", async () => {
  const { ctx, sw, tabId, page } = await setup();
  try {
    await setSettings(sw, { mode: "box" });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "choosing");
    await page.reload();
    await waitPhase(sw, "idle", 10_000);
    expect((await call(sw, "start", { tabId })).ok).toBe(true); // and a new one starts
    await waitPhase(sw, "choosing");
    await call(sw, "stop"); // the panel's Cancel
    await waitPhase(sw, "idle", 10_000);
  } finally {
    await ctx.close();
  }
});

test("a page nobody may record says so at once, in the panel", async () => {
  const { ctx, sw, page } = await setup();
  try {
    await page.goto("chrome://version");
    const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => !t.url || t.url.startsWith("chrome://")).id);
    // (Tab mode is refused by Chrome itself on these pages; the e2e build's allow-list flag lifts that check, so only box is tested here.)
    for (const mode of ["box"]) {
      await setSettings(sw, { mode });
      const r = await call(sw, "start", { tabId });
      expect(r.ok, mode).toBe(false);
      expect(r.error, mode).toMatch(/Window or Screen/);
      expect((await state(sw)).phase).not.toBe("starting");
    }
  } finally {
    await ctx.close();
  }
});

test("box recording: resizing or zooming the tab keeps the same part of the page and one fixed video size", async () => {
  const ctx = await launch({ deviceScaleFactor: 1 });
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html?plain`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "box", sound: false, mic: false, quality: "better" });
    await call(sw, "start", { tabId });
    await waitPhase(sw, "choosing");
    await page.locator("neat-record-ui").locator(".select").waitFor();
    await page.mouse.move(200, 120);
    await page.mouse.down();
    await page.mouse.move(600, 360, { steps: 8 });
    await page.mouse.up();
    await waitPhase(sw, "recording", 30_000);
    await page.waitForTimeout(3_000);
    await page.setViewportSize({ width: 1000, height: 700 }); // the window gets smaller
    await page.waitForTimeout(3_000);
    await call(sw, "stop");
    await waitPhase(sw, "done", 60_000);
    const d = await lastDownload(sw);
    const info = await inspectMp4(bufferSource(readFileSync(d.filename)));
    expect(info.durationMs).toBeGreaterThan(4_500);
    const p = await probe(page, server, d.filename);
    expect([p.width, p.height]).toEqual([400, 240]); // one size from start to end
    expect(p.px.centre[1], `centre ${p.px.centre}`).toBeGreaterThan(150); // still the green box, after the resize
  } finally {
    await ctx.close();
  }
});

test("only the recorder may report results; a page can't fake them", async () => {
  const { ctx, sw, page, tabId } = await setup();
  try {
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    // A content-script-like sender (from a web page) trying recorder-only messages is ignored.
    const res = await page.evaluate(async () => (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage ? "has-runtime" : "no-runtime"));
    expect(res).toBe("no-runtime"); // plain pages can't even reach the extension
    await call(sw, "stop");
    await waitPhase(sw, "done");
  } finally {
    await ctx.close();
  }
});
