// Draw-a-box maths, the free limiter, quality presets, settings, file names.
import { test, expect } from "@playwright/test";
import { normaliseDrag, cropRect, captureSize, contentRect, fitHeight } from "../../apps/record/src/lib/crop.js";
import { createLimiter, shouldShowLimitNote, dayKey } from "../../apps/record/src/lib/limiter.js";
import { PRESETS, presetById, sizeLabel, videoBitrate, DEFAULT_PRESET } from "../../apps/record/src/lib/presets.js";
import { normaliseSettings, fileName, pickFormat, avcLevel, clock, isBrowserPage, trimmedName } from "../../apps/record/src/lib/format.js";
import { extensionIdFromKey } from "../../scripts/extension-key.mjs";
import app from "../../apps/record/app.config.js";

test.describe("crop maths", () => {
  for (const dpr of [1, 1.5, 2]) {
    test(`a box maps to exact device pixels at DPR ${dpr}`, () => {
      const vw = 1280;
      const vh = 720;
      const frame = { w: Math.round(vw * dpr), h: Math.round(vh * dpr) };
      const box = { x: 101, y: 57, w: 333, h: 211 };
      const r = cropRect(box, vw, vh, frame.w, frame.h);
      // Never loses a selected pixel: the crop covers the box in device pixels…
      expect(r.x).toBeLessThanOrEqual(box.x * dpr);
      expect(r.y).toBeLessThanOrEqual(box.y * dpr);
      expect(r.x + r.width).toBeGreaterThanOrEqual(Math.floor((box.x + box.w) * dpr) - 1);
      expect(r.y + r.height).toBeGreaterThanOrEqual(Math.floor((box.y + box.h) * dpr) - 1);
      // …adds at most 2 device pixels per edge (alignment), and is 4:2:0-friendly (even).
      expect(box.x * dpr - r.x).toBeLessThan(2);
      expect(r.width - box.w * dpr).toBeLessThanOrEqual(3);
      for (const v of [r.x, r.y, r.width, r.height]) expect(v % 2).toBe(0);
    });
  }

  test("letterboxed frames: content offset is accounted for", () => {
    // 1280x720 viewport captured into a 4:3 frame → bars top and bottom.
    const c = contentRect(1600, 1200, 1280, 720);
    expect(c.scale).toBeCloseTo(1.25);
    expect(c.y).toBeCloseTo(150);
    const r = cropRect({ x: 0, y: 0, w: 640, h: 360 }, 1280, 720, 1600, 1200);
    expect(r).toEqual({ x: 0, y: 150, width: 800, height: 450 - (450 % 2) });
  });

  test("boxes at the edges stay inside the frame", () => {
    const r = cropRect({ x: 1200, y: 700, w: 80, h: 20 }, 1280, 720, 2560, 1440);
    expect(r.x + r.width).toBeLessThanOrEqual(2560);
    expect(r.y + r.height).toBeLessThanOrEqual(1440);
    const odd = cropRect({ x: 0, y: 0, w: 1280, h: 720 }, 1280, 720, 1921, 1081);
    expect(odd.width % 2).toBe(0);
    expect(odd.width).toBeLessThanOrEqual(1921);
  });

  test("drags in any direction, clamped to the viewport", () => {
    expect(normaliseDrag(300, 200, 100, 50, 1280, 720)).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(normaliseDrag(-20, -20, 50, 50, 1280, 720)).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    expect(normaliseDrag(1200, 700, 1400, 900, 1280, 720)).toEqual({ x: 1200, y: 700, w: 80, h: 20 });
  });

  test("capture size: native device pixels, scaled down only to the preset, never up", () => {
    expect(captureSize(1280, 720, 2, 2160)).toEqual({ width: 2560, height: 1440 });
    expect(captureSize(1920, 1080, 1, 720)).toEqual({ width: 1280, height: 720 });
    expect(captureSize(1280, 720, 1, 2160)).toEqual({ width: 1280, height: 720 });
    // A small box keeps full sharpness even on Good: the box, not the tab, is what counts.
    expect(captureSize(1280, 720, 2, 720, { x: 0, y: 0, w: 400, h: 300 })).toEqual({ width: 2560, height: 1440 });
    const s = captureSize(1366, 768, 1.5, 1080);
    expect(s.width % 2 + (s.height % 2)).toBe(0);
  });
});

test.describe("free 10-minute limiter", () => {
  function clockAt() {
    let t = 0;
    const timers = [];
    return {
      now: () => t,
      advance(ms) {
        t += ms;
        for (const tm of [...timers].sort((a, b) => a.at - b.at)) {
          if (tm.at <= t && !tm.done) {
            tm.done = true;
            tm.fn();
          }
        }
      },
      setTimer: (fn, ms) => {
        const tm = { fn, at: t + ms, done: false };
        timers.push(tm);
        return tm;
      },
      clearTimer: (tm) => tm && (tm.done = true),
    };
  }

  test("stops at exactly 10:00 of recorded time, once", () => {
    const c = clockAt();
    let fired = 0;
    const l = createLimiter({ limitMs: 600_000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onLimit: () => fired++ });
    l.start();
    c.advance(599_000);
    expect(fired).toBe(0);
    c.advance(1_000);
    expect(fired).toBe(1);
    c.advance(60_000);
    expect(fired).toBe(1);
    expect(l.hitLimit).toBe(true);
  });

  test("paused time does not count", () => {
    const c = clockAt();
    let fired = 0;
    const l = createLimiter({ limitMs: 600_000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onLimit: () => fired++ });
    l.start();
    c.advance(300_000);
    l.pause();
    c.advance(900_000);
    expect(fired).toBe(0);
    l.resume();
    c.advance(299_000);
    expect(fired).toBe(0);
    c.advance(1_000);
    expect(fired).toBe(1);
  });

  test("time-scaled for tests: scale 60 turns 10 minutes into 10 seconds", () => {
    const c = clockAt();
    let fired = 0;
    const l = createLimiter({ limitMs: 600_000, timeScale: 60, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onLimit: () => fired++ });
    l.start();
    c.advance(9_900);
    expect(fired).toBe(0);
    c.advance(100);
    expect(fired).toBe(1);
    expect(l.elapsed()).toBe(600_000);
  });

  test("Pro: no limit", () => {
    const c = clockAt();
    let fired = 0;
    const l = createLimiter({ limitMs: Infinity, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, onLimit: () => fired++ });
    l.start();
    c.advance(10 * 3600_000);
    expect(fired).toBe(0);
  });

  test("the quiet note shows at most once per day", () => {
    const d1 = dayKey(new Date(2026, 9, 23, 9));
    const d1later = dayKey(new Date(2026, 9, 23, 23, 59));
    const d2 = dayKey(new Date(2026, 9, 24, 0, 1));
    expect(shouldShowLimitNote(undefined, d1)).toBe(true);
    expect(shouldShowLimitNote(d1, d1later)).toBe(false);
    expect(shouldShowLimitNote(d1, d2)).toBe(true);
  });
});

test.describe("quality presets", () => {
  test("plain words, Better is the default, Best is Pro", () => {
    expect(PRESETS.map((p) => [p.label, p.detail])).toEqual([
      ["Good", "720p"],
      ["Better", "1080p HD"],
      ["Best", "1440p / 4K"],
    ]);
    expect(DEFAULT_PRESET).toBe("better");
    expect(presetById("best", { pro: false }).id).toBe("better");
    expect(presetById("best", { pro: true }).id).toBe("best");
    expect(presetById("nonsense").id).toBe("better");
    for (const p of PRESETS) expect(sizeLabel(p)).toMatch(/^~\d+ MB a minute$/);
  });

  test("Best scales its bitrate with the real pixel count, capped", () => {
    const best = presetById("best", { pro: true });
    expect(PRESETS.map((p) => p.mbPerMin)).toEqual([10, 20, 40]); // measured, see measure.spec.js
    expect(videoBitrate(best, 2560, 1440)).toBe(best.videoBps);
    expect(videoBitrate(best, 3840, 2160)).toBeGreaterThan(best.videoBps);
    expect(videoBitrate(best, 7680, 4320)).toBe(12_000_000);
    expect(videoBitrate(presetById("good"), 3840, 2160)).toBe(presetById("good").videoBps);
  });
});

test.describe("settings, names, formats", () => {
  test("settings are normalised, unknown values fall back", () => {
    expect(normaliseSettings(null)).toEqual({ mode: "box", mic: false, sound: true, quality: "better", camera: false, clicks: false, countdown: false });
    expect(normaliseSettings({ mode: "box", mic: "yes", quality: "ultra", sound: false })).toMatchObject({ mode: "box", mic: false, quality: "better", sound: false });
  });

  test("file names sort by date and are safe on Windows", () => {
    expect(fileName("Neat Record", new Date(2026, 9, 23, 14, 5, 32), "mp4")).toBe("Neat Record 2026-10-23 at 14.05.32.mp4");
    expect(fileName('A:B"C', new Date(2026, 0, 2, 3, 4, 5), "webm", " (trimmed)")).toBe("A-B-C 2026-01-02 at 03.04.05 (trimmed).webm");
  });

  test("MP4 preferred, WebM when Chrome can't record MP4", () => {
    expect(pickFormat(true, 1920, 1080, () => true).ext).toBe("mp4");
    expect(pickFormat(true, 3840, 2160, () => true).mime).toContain("avc1.640033");
    expect(pickFormat(false, 1280, 720, (t) => t.startsWith("video/webm")).mime).toBe("video/webm;codecs=vp9");
    expect(pickFormat(true, 1280, 720, () => false).ext).toBe("webm");
  });

  test("H.264 level follows the real frame size, not just the height", () => {
    expect(avcLevel(1920, 1080)).toBe("28"); // 8160 macroblocks: level 4.0
    expect(avcLevel(2048, 1088)).toBe("2a"); // 8704: level 4.2
    expect(avcLevel(2580, 1080)).toBe("32"); // ultrawide at 1080 lines: 11,034 macroblocks, too many for 4.0
    expect(avcLevel(2560, 1440)).toBe("32");
    expect(avcLevel(3840, 2160)).toBe("33");
  });

  test("clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(61_900)).toBe("1:01");
    expect(clock(3_725_000)).toBe("1:02:05");
  });

  test("the pinned extension ID matches the manifest key", () => {
    expect(extensionIdFromKey(app.extensionKey)).toBe(app.extensionId);
    expect(app.extensionId).toMatch(/^[a-p]{32}$/);
  });
});

test.describe("screen size for each quality (fitHeight)", () => {
  // Real monitors: the label's height, same shape — not a whole-number fraction of the screen.
  for (const [w, h, max, want] of [
    [2560, 1440, 1080, [1920, 1080]],
    [2560, 1440, 720, [1280, 720]],
    [2880, 1620, 1080, [1920, 1080]],
    [3840, 2160, 2160, [3840, 2160]],
    [3440, 1440, 1080, [2580, 1080]],
    [1920, 1200, 1080, [1728, 1080]],
    [1366, 768, 1080, [1366, 768]], // never enlarged
    [1365, 767, 720, [1282, 720]],
    [1365, 767, null, [1364, 766]],
  ]) {
    test(`${w}×${h} at ${max ?? "own size"} → ${want.join("×")}`, () => {
      expect(Object.values(fitHeight(w, h, max))).toEqual(want);
    });
  }
});

test("This page refuses the browser's own pages, and only those", () => {
  for (const u of ["edge://version", "chrome://settings", "about:blank", "brave://rewards", "chrome-extension://abc/popup.html", "view-source:https://a.com"]) expect(isBrowserPage(u), u).toBe(true);
  for (const u of ["https://example.com", "http://127.0.0.1:8080/x", "https://chromewebstore.google.com/detail/x", "file:///C:/a.html", "", undefined]) expect(isBrowserPage(u), String(u)).toBe(false);
});

test("trimming again never stacks '(trimmed)' and never clashes with the first trim", () => {
  const a = "Neat Record 2026-10-25 at 04.40.17.mp4";
  const once = trimmedName(a, "mp4");
  expect(once).toBe("Neat Record 2026-10-25 at 04.40.17 (trimmed).mp4");
  expect(trimmedName(once, "mp4")).toBe(once);
  expect(trimmedName("Neat Record 2026-10-25 at 04.40.17 (trimmed) (trimmed).webm", "webm")).toBe("Neat Record 2026-10-25 at 04.40.17 (trimmed).webm");
  // A second trim gets its own name, so the browser never has to rename it to "… (1)".
  expect(trimmedName(once, "mp4", 2)).toBe("Neat Record 2026-10-25 at 04.40.17 (trimmed 2).mp4");
  expect(trimmedName("Neat Record 2026-10-25 at 04.40.17 (trimmed 2) (1).mp4", "mp4", 3)).toBe("Neat Record 2026-10-25 at 04.40.17 (trimmed 3).mp4");
});
