// Measurements that feed the UI labels and the report:
//  1. real file size per quality preset on a busy page (MB per minute);
//  2. draw-a-box crop: VideoFrame visibleRect vs canvas drawImage (pixels and time per frame);
//  3. bundle size on disk.
// Results: test-results/record-measure.json.
import { test, expect, launch, worker, startServer, tabIdOf, recordFor, unlockPro, RESULTS, EXT_DIR } from "./helpers.js";
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { inspectMp4 } from "../../apps/record/src/lib/mp4.js";

const OUT = path.join(RESULTS, "record-measure.json");
const result = () => (existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {});
const save = (patch) => writeFileSync(OUT, JSON.stringify({ ...result(), ...patch }, null, 2));
// 60 s: shorter samples under-count, the encoder spends its first seconds ramping up.
const SECONDS = Number(process.env.RECORD_MEASURE_SECONDS || 60);

let server;
test.beforeAll(async () => (server = await startServer()));
test.afterAll(async () => server.close());

const RUNS = [
  { preset: "good", viewport: { width: 1920, height: 1080 }, dpr: 1, expect: [1280, 720] },
  { preset: "better", viewport: { width: 1920, height: 1080 }, dpr: 1, expect: [1920, 1080] },
  { preset: "best", viewport: { width: 1280, height: 720 }, dpr: 2, expect: [2560, 1440], pro: true },
  { preset: "best", viewport: { width: 1920, height: 1080 }, dpr: 2, expect: [3840, 2160], pro: true, label: "best-4k" },
];

test("file size per minute for each quality, on a busy page", async () => {
  test.setTimeout(10 * 60_000);
  const sizes = {};
  for (const run of RUNS) {
    const ctx = await launch({ viewport: run.viewport, deviceScaleFactor: run.dpr });
    try {
      const sw = await worker(ctx);
      await unlockPro(sw); // no 10-minute limit in the way of a full-length sample
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(`${server.base}/busy.html`);
      const tabId = await tabIdOf(sw, server.base);
      const { download } = await recordFor(sw, { tabId, ms: SECONDS * 1000, settings: { mode: "tab", sound: true, mic: true, quality: run.preset, countdown: false, camera: false, clicks: false } });
      const info = await inspectMp4(bufferSource(readFileSync(download.filename)));
      const mbPerMin = download.fileSize / (1024 * 1024) / (info.durationMs / 60_000);
      sizes[run.label || run.preset] = { resolution: run.expect.join("x"), seconds: +(info.durationMs / 1000).toFixed(2), bytes: download.fileSize, mbPerMin: +mbPerMin.toFixed(1) };
    } finally {
      await ctx.close();
    }
  }
  save({ sizes });
  console.log("  sizes:", JSON.stringify(sizes));
  // The labels in the panel must be within 35% of what was measured (busy page = upper end of normal use).
  const { PRESETS } = await import("../../apps/record/src/lib/presets.js");
  for (const p of PRESETS) {
    const m = sizes[p.id].mbPerMin;
    expect(Math.abs(m - p.mbPerMin) / p.mbPerMin, `${p.id}: label ~${p.mbPerMin} MB/min, measured ${m}`).toBeLessThan(0.35);
  }
});

test("draw-a-box crop: visibleRect keeps every pixel and costs least", async () => {
  const browser = await chromium.launch({ channel: "chromium", args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    const page = await browser.newPage();
    await page.goto(`${server.base}/player.html`);
    const r = await page.evaluate(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } });
      const track = s.getVideoTracks()[0];
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
      const rect = { x: 202, y: 114, width: 666, height: 422 };
      const read = (vf) => {
        const c = new OffscreenCanvas(rect.width, rect.height);
        const g = c.getContext("2d");
        g.drawImage(vf, 0, 0);
        return g.getImageData(0, 0, rect.width, rect.height).data;
      };
      const tA = [];
      const tB = [];
      let maxDiff = 0;
      let maxDiffB = 0;
      let se = 0;
      let n = 0;
      for (let i = 0; i < 40; i++) {
        const { value: frame } = await reader.read();
        let t = performance.now();
        const a = new VideoFrame(frame, { visibleRect: rect, timestamp: frame.timestamp });
        tA.push(performance.now() - t);
        t = performance.now();
        const c = new OffscreenCanvas(rect.width, rect.height);
        c.getContext("2d").drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        const b = new VideoFrame(c, { timestamp: frame.timestamp });
        tB.push(performance.now() - t);
        if (i >= 30) {
          // Reference: the source frame cropped on readback, pixel for pixel.
          const full = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
          const fg = full.getContext("2d");
          fg.drawImage(frame, 0, 0);
          const ref = fg.getImageData(rect.x, rect.y, rect.width, rect.height).data;
          const da = read(a);
          const db = read(b);
          for (let p = 0; p < ref.length; p += 4) {
            for (let k = 0; k < 3; k++) {
              const ea = da[p + k] - ref[p + k];
              const eb = db[p + k] - ref[p + k];
              maxDiff = Math.max(maxDiff, Math.abs(ea));
              maxDiffB = Math.max(maxDiffB, Math.abs(eb));
              se += eb * eb;
              n++;
            }
          }
          var sizes = [a.displayWidth, a.displayHeight, a.codedWidth, a.codedHeight];
        }
        a.close();
        b.close();
        frame.close();
      }
      track.stop();
      const med = (x) => x.sort((p, q) => p - q)[Math.floor(x.length / 2)];
      return { visibleRect: { msPerFrame: med(tA), maxPixelDiff: maxDiff, size: sizes }, canvas: { msPerFrame: med(tB), maxPixelDiff: maxDiffB, psnr: se ? +(10 * Math.log10((255 * 255) / (se / n))).toFixed(1) : "identical" } };
    });
    save({ crop: r });
    console.log("  crop:", JSON.stringify(r));
    expect(r.visibleRect.maxPixelDiff).toBe(0); // bit-exact: no resampling, no colour round-trip
    expect(r.visibleRect.size.slice(0, 2)).toEqual([666, 422]);
    expect(r.visibleRect.msPerFrame).toBeLessThanOrEqual(r.canvas.msPerFrame);
  } finally {
    await browser.close();
  }
});

test("bundle size", async () => {
  let total = 0;
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(EXT_DIR);
  save({ bundleBytes: total });
  expect(total).toBeLessThan(400 * 1024);
});
