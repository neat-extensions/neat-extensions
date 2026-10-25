// The things that go wrong in real life: a crash mid-recording, Stop during
// 3-2-1, closing the card while it saves, the page reloading under the box
// overlay, pages Chrome won't let anyone record.
import { test, expect, launch, worker, startServer, setSettings, tabIdOf, call, waitPhase, lastDownload, state, unlockPro, probe, RESULTS, CHANNEL } from "./helpers.js";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
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
    // The browser's own page under its own name (Edge loads chrome:// pages by redirecting, which can crash the tab).
    const internal = CHANNEL === "msedge" ? "edge://version" : "chrome://version";
    await page.goto(internal);
    const tabId = await sw.evaluate(async (scheme) => (await chrome.tabs.query({})).find((t) => !t.url || t.url.startsWith(scheme)).id, internal.split("//")[0] + "//");
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

test("Stop pressed after the recorder crashed saves what was recorded", async () => {
  const { ctx, sw, tabId } = await setup();
  try {
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await new Promise((r) => setTimeout(r, 5_000));
    await sw.evaluate(() => chrome.offscreen.closeDocument());
    // The panel still says "Recording"; the natural thing to press is Stop.
    await call(sw, "stop");
    const st = await waitPhase(sw, ["done", "error"], 60_000);
    expect(st.phase).toBe("done");
    expect(st.last.filename).toMatch(/\(recovered\)\.mp4$/);
    const info = await inspectMp4(bufferSource(readFileSync((await lastDownload(sw)).filename)));
    expect(info.durationMs).toBeGreaterThan(2_000);
  } finally {
    await ctx.close();
  }
});

test("a Pro recording kept for Share/Trim/GIF is not saved again after a browser restart", async () => {
  const userDataDir = path.join(RESULTS, `restart-profile-${Date.now()}`);
  const first = await setup({ userDataDir });
  try {
    await unlockPro(first.sw);
    await call(first.sw, "start", { tabId: first.tabId });
    await waitPhase(first.sw, "recording");
    await new Promise((r) => setTimeout(r, 3_000));
    await call(first.sw, "stop");
    await waitPhase(first.sw, "done");
    // Pro keeps the file for Share, Trim and GIF; the card is never closed.
    expect(await opfsNames(first.sw)).toHaveLength(1);
  } finally {
    await first.ctx.close();
  }
  const ctx = await launch({ userDataDir });
  try {
    const sw = await worker(ctx);
    await expect.poll(() => opfsNames(sw), { timeout: 20_000 }).toEqual([]); // the leftover is deleted, not recovered
    const saved = await sw.evaluate(() => chrome.downloads.search({ state: "complete" }));
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).not.toMatch(/recovered/);
    expect((await state(sw)).phase).toBe("idle");
  } finally {
    await ctx.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

const opfsNames = (sw) =>
  sw.evaluate(async () => {
    const out = [];
    for await (const name of (await navigator.storage.getDirectory()).keys()) out.push(name);
    return out;
  });

test("a start that fails leaves nothing stuck: back to idle, and if the browser still holds the page the message says how to get out", async () => {
  // The fake screen-picker switch breaks tab capture: a dependable way to make a start fail.
  const ctx = await launch({ display: true });
  try {
    const sw = await worker(ctx);
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: false, mic: false });
    await call(sw, "start", { tabId });
    const st = await waitPhase(sw, "error", 20_000);
    expect(st.toast).toBe("The recording couldn't start. Try again.");
    expect(await sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
    await call(sw, "dismiss");
    expect((await state(sw)).phase).toBe("idle");
    const again = await call(sw, "start", { tabId });
    expect(again.ok).toBe(false);
    expect(again.error).toBe("Your browser is still holding this page after the last try. Close this tab and open the page again, or pick Screen.");
    expect((await state(sw)).phase).toBe("idle");
  } finally {
    await ctx.close();
  }
});

test("closing the recorded tab saves the recording and says just that", async () => {
  const { ctx, sw, page, tabId } = await setup();
  try {
    await ctx.newPage(); // the browser stays open
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await new Promise((r) => setTimeout(r, 3_000));
    await page.close();
    const st = await waitPhase(sw, "done", 60_000);
    expect(st.note).toBe("Recording saved.");
    const info = await inspectMp4(bufferSource(readFileSync((await lastDownload(sw)).filename)));
    expect(info.durationMs).toBeGreaterThan(1_500);
  } finally {
    await ctx.close();
  }
});

test("after the extension is reloaded, a Saved card left by the old copy goes away when touched, and never stacks", async () => {
  const { ctx, sw, page, tabId } = await setup();
  try {
    await call(sw, "start", { tabId });
    await waitPhase(sw, "recording");
    await new Promise((r) => setTimeout(r, 2_000));
    await call(sw, "stop");
    await waitPhase(sw, "done");
    const ui = page.locator("neat-record-ui");
    await expect(ui.locator(".card")).toBeVisible();
    await sw.evaluate(() => chrome.runtime.reload());
    const sw2 = await ctx.waitForEvent("serviceworker", { timeout: 20_000 });
    // The old card can't reach the new copy: pressing it removes it instead of doing nothing.
    await ui.locator('[data-act="show"]').click();
    await expect(ui).toHaveCount(0);
    // A new recording on the same page: one page UI, not two stacked.
    await setSettings(sw2, { mode: "tab", sound: false, mic: false });
    const t2 = await tabIdOf(sw2, server.base);
    await call(sw2, "start", { tabId: t2 });
    await waitPhase(sw2, "recording");
    await call(sw2, "stop");
    await waitPhase(sw2, "done");
    await expect(page.locator("neat-record-ui")).toHaveCount(1);
  } finally {
    await ctx.close();
  }
});

test("This page on the browser's own page: refused with a clear message, no picture-less file saved", async () => {
  const { ctx, sw, page } = await setup();
  try {
    const internal = CHANNEL === "msedge" ? "edge://version" : "chrome://version";
    await page.goto(internal);
    const tabId = await sw.evaluate(async (scheme) => (await chrome.tabs.query({})).find((t) => !t.url || t.url.startsWith(scheme)).id, internal.split("//")[0] + "//");
    const before = (await sw.evaluate(() => chrome.downloads.search({}))).length;
    await setSettings(sw, { mode: "tab", sound: true, mic: false });
    const r = await call(sw, "start", { tabId });
    // Either refused at once, or the capture starts but no picture ever comes: the same message.
    const st = r.ok ? await waitPhase(sw, ["error", "recording"], 20_000) : null;
    expect(st ? st.phase : "refused").not.toBe("recording");
    expect(r.ok ? st.toast : r.error).toBe("This page can't be recorded. Open a normal web page, or pick Window or Screen.");
    expect((await sw.evaluate(() => chrome.downloads.search({}))).length).toBe(before);
    expect(await sw.evaluate(() => chrome.offscreen.hasDocument())).toBe(false);
  } finally {
    await ctx.close();
  }
});
