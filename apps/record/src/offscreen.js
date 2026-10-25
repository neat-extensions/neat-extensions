// The recorder. Runs in the extension's offscreen document (reasons USER_MEDIA,
// DISPLAY_MEDIA, BLOBS, WORKERS), which exists only while recording or while a
// Pro job (trim, GIF, share) runs; the service worker closes it afterwards.
//
// Capture → (crop / fixed size) → MediaRecorder → chunks written straight into
// an OPFS file by a worker (sync access handle), so memory stays flat and a
// crash or full disk keeps what was recorded. On stop the container is
// repaired without copying: the repaired file is a Blob made of new header
// bytes and slices of the raw file, handed to the service worker as a blob:
// URL for the download. Nothing here touches the network except the Drive
// upload, which only runs after the user pressed Share.
import { cropRect, fitHeight } from "./lib/crop.js";
import { createLimiter } from "./lib/limiter.js";
import { presetById, videoBitrate, AUDIO_BPS } from "./lib/presets.js";
import { fileSource, partsToBlob } from "./lib/bytes.js";
import { pickFormat } from "./lib/format.js";
import { planWebm } from "./lib/webm.js";
import { planMp4 } from "./lib/mp4.js";
import { buildPalette, createGifEncoder } from "./lib/gif.js";
import { createDrive, DriveError } from "./lib/drive.js";

const TIME_SCALE = Number(process.env.RECORD_TIME_SCALE || 1);
const DRIVE_BASE = process.env.RECORD_DRIVE_BASE || "https://www.googleapis.com";
const STILL_MS = 250;
const SW_URL = chrome.runtime.getURL("background.js");
const toSw = (msg) => chrome.runtime.sendMessage({ ...msg, target: "sw" }).catch(() => {});
const timeout = (ms, what) => new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took too long`)), ms));

let rec = null; // the recording in progress

// ---------------------------------------------------------------- OPFS
const dir = () => navigator.storage.getDirectory();
async function clearAll(keep = []) {
  const d = await dir();
  for await (const name of d.keys()) if (!keep.includes(name)) await d.removeEntry(name).catch(() => {});
}
async function fileOf(name) {
  return (await (await dir()).getFileHandle(name)).getFile();
}
const typeOf = (ext) => (ext === "mp4" ? "video/mp4" : "video/webm");

/** The chunk writer (src/writer.js): a promise per message, in order. */
function startWriter(name) {
  const w = new Worker("writer.js");
  let next = 0;
  const waiting = new Map();
  w.onmessage = ({ data }) => {
    const p = waiting.get(data.id);
    waiting.delete(data.id);
    if (p) (data.ok ? p.res : p.rej)(data.ok ? data : new Error(data.error));
  };
  const call = (msg, transfer) =>
    new Promise((res, rej) => {
      const id = ++next;
      waiting.set(id, { res, rej });
      w.postMessage({ ...msg, id }, transfer || []);
    });
  return {
    open: () => call({ op: "open", name }),
    write: (buf) => call({ op: "write", buf }, [buf]),
    close: async () => {
      try {
        await call({ op: "close" });
      } finally {
        w.terminate();
      }
    },
  };
}

// ---------------------------------------------------------------- capture
async function captureTab(streamId, size, withAudio) {
  const v = { chromeMediaSource: "tab", chromeMediaSourceId: streamId, minWidth: size.width, maxWidth: size.width, minHeight: size.height, maxHeight: size.height, maxFrameRate: 30 };
  return navigator.mediaDevices.getUserMedia({ video: { mandatory: v }, audio: withAudio ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } : false });
}

async function captureDisplay(mode, withAudio) {
  // The screen at its own size (resizeMode "none"): Chrome would otherwise shrink a big screen by a whole
  // number (2880×1620 → 1440×810 for "1080p"). frameTrack scales it to the preset's height instead.
  return navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: mode === "window" ? "window" : "monitor", resizeMode: "none", frameRate: { ideal: 30, max: 30 } },
    audio: withAudio,
    systemAudio: withAudio ? "include" : "exclude",
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    monitorTypeSurfaces: "include",
  });
}

/**
 * One frame pipeline for every mode: frames pass through untouched while they
 * are the size the encoder was set up with (the MP4 track has one fixed size).
 * Draw-a-box crops with VideoFrame visibleRect — a zero-copy view of the frame,
 * no scaling, no colour conversion (measured in tests/e2e-record/measure.spec.js).
 * A resized window, a switched source or a resized/zoomed tab is scaled into
 * the fixed size instead of breaking the file. Paused: frames are dropped here.
 * A page where nothing moves sends no new frames at all: the last frame is
 * repeated every STILL_MS so the video has a picture for its whole length.
 */
function frameTrack(track, { box = null, viewport = null, maxHeight = null, isPaused }) {
  const proc = new MediaStreamTrackProcessor({ track });
  const gen = new MediaStreamTrackGenerator({ kind: "video" });
  let size = null; // the encoder's size, fixed by the first frame
  let view = viewport;
  let key = "";
  let rect = null;
  let canvas = null;
  let held = null; // the last frame sent, kept to repeat while the picture is still
  let heldAt = 0;
  let still = null;
  let ctlRef = null;
  let copy = null;
  const repeat = () => {
    still = setTimeout(repeat, STILL_MS);
    if (!held || isPaused()) return;
    try {
      // A fresh frame drawn from the held one: the recorder ignores a re-sent captured frame
      // (measured: 35 re-sent tab frames still gave a one-frame file; drawn copies give a frame each).
      if (!copy || copy.width !== held.displayWidth || copy.height !== held.displayHeight) copy = new OffscreenCanvas(held.displayWidth, held.displayHeight);
      copy.getContext("2d").drawImage(held, 0, 0);
      ctlRef.enqueue(new VideoFrame(copy, { timestamp: held.timestamp + Math.round((performance.now() - heldAt) * 1000) }));
    } catch {
      clearTimeout(still); // the stream has ended
    }
  };
  const emit = (ctl, vf) => {
    ctlRef = ctl;
    held?.close();
    held = vf.clone();
    heldAt = performance.now();
    clearTimeout(still);
    still = setTimeout(repeat, STILL_MS);
    ctl.enqueue(vf);
  };
  const setViewport = (v) => {
    view = v;
    key = "";
  };
  const out = new TransformStream({
    transform(frame, ctl) {
      try {
        if (isPaused()) return;
        const fw = frame.displayWidth;
        const fh = frame.displayHeight;
        const k = `${fw}x${fh}:${view ? `${view.w}x${view.h}` : ""}`;
        if (k !== key) {
          key = k;
          rect = box ? cropRect(box, view.w, view.h, fw, fh) : { x: 0, y: 0, width: fw - (fw % 2), height: fh - (fh % 2) };
          if (!size) size = fitHeight(rect.width, rect.height, maxHeight);
          canvas = rect.width === size.width && rect.height === size.height ? null : new OffscreenCanvas(size.width, size.height);
        }
        if (!canvas) {
          emit(ctl, box || rect.width !== fw || rect.height !== fh ? new VideoFrame(frame, { visibleRect: rect, timestamp: frame.timestamp }) : frame.clone());
          return;
        }
        // Scale into the fixed size, letterboxed, keeping the picture's shape.
        const g = canvas.getContext("2d");
        const s = Math.min(size.width / rect.width, size.height / rect.height);
        const w = rect.width * s;
        const h = rect.height * s;
        g.fillStyle = "#000";
        g.fillRect(0, 0, size.width, size.height);
        g.drawImage(frame, rect.x, rect.y, rect.width, rect.height, (size.width - w) / 2, (size.height - h) / 2, w, h);
        emit(ctl, new VideoFrame(canvas, { timestamp: frame.timestamp }));
      } finally {
        frame.close();
      }
    },
    flush() {
      clearTimeout(still);
      held?.close();
      held = null;
    },
  });
  proc.readable.pipeThrough(out).pipeTo(gen.writable).catch(() => {});
  return { track: gen, setViewport };
}

async function micStream() {
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
}

/** The first frame's size, so the encoder (and the H.264 level) match what will really be recorded. */
async function firstFrameSize(track) {
  const s = track.getSettings();
  if (s.width && s.height) return { width: s.width, height: s.height };
  return { width: 1920, height: 1080 };
}

// ---------------------------------------------------------------- recording
async function start(m) {
  if (rec) throw new Error("already recording");
  await clearAll();
  const preset = presetById(m.quality, { pro: m.pro });
  const streams = [];
  let video;
  let soundStream = null;
  try {
    if (m.mode === "tab" || m.mode === "box") {
      const s = await captureTab(m.streamId, m.captureSize, m.sound);
      streams.push(s);
      video = s.getVideoTracks()[0];
      if (m.sound && s.getAudioTracks().length) soundStream = new MediaStream(s.getAudioTracks());
    } else {
      const s = await captureDisplay(m.mode, m.sound && m.mode !== "window");
      streams.push(s);
      video = s.getVideoTracks()[0];
      if (s.getAudioTracks().length) soundStream = new MediaStream(s.getAudioTracks());
    }
  } catch (e) {
    for (const s of streams) s.getTracks().forEach((t) => t.stop());
    // The user closed the screen picker: not an error, just nothing to record.
    throw Object.assign(new Error(e && e.name === "NotAllowedError" ? "cancelled" : String((e && e.message) || e)), { quiet: e && e.name === "NotAllowedError" });
  }

  let micBlocked = false;
  let mic = null;
  if (m.mic) {
    try {
      mic = await micStream();
      streams.push(mic);
    } catch {
      micBlocked = true;
    }
  }

  // Audio: tab/system sound and the microphone mixed into one track. Tab sound is
  // also played back, because capturing a tab mutes it for the user otherwise.
  let audioCtx = null;
  let audioTrack = null;
  if (soundStream || mic) {
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    if (soundStream) {
      const src = audioCtx.createMediaStreamSource(soundStream);
      src.connect(dest);
      if (m.mode === "tab" || m.mode === "box") src.connect(audioCtx.destination);
    }
    if (mic) audioCtx.createMediaStreamSource(mic).connect(dest);
    audioTrack = dest.stream.getAudioTracks()[0];
  }

  let paused = false;
  const raw = await firstFrameSize(video);
  // Screen and Window arrive at their own size and are scaled to the preset here; tabs are captured at it already.
  const display = m.mode === "screen" || m.mode === "window";
  const pipe = frameTrack(video, { box: m.mode === "box" ? m.box : null, viewport: m.viewport, maxHeight: display ? preset.height : null, isPaused: () => paused });
  const out = m.mode === "box" ? cropRect(m.box, m.viewport.w, m.viewport.h, raw.width, raw.height) : fitHeight(raw.width, raw.height, display ? preset.height : null);
  const fmt = pickFormat(!!audioTrack, out.width, out.height, (t) => MediaRecorder.isTypeSupported(t));
  const stamp = m.stamp || Date.now();
  const rawName = `rec-${stamp}.${fmt.ext}.raw`;
  const writer = startWriter(rawName);
  await writer.open();
  const mixed = new MediaStream([pipe.track, ...(audioTrack ? [audioTrack] : [])]);
  const recorder = new MediaRecorder(mixed, { mimeType: fmt.mime, videoBitsPerSecond: videoBitrate(preset, out.width, out.height), audioBitsPerSecond: AUDIO_BPS, videoKeyFrameIntervalDuration: 1000 });

  // Chunks are written in order. A failed write (disk full) stops the recording; what landed is saved.
  let chain = Promise.resolve();
  let writeError = null;
  let firstData;
  const gotData = new Promise((res) => (firstData = res));
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    firstData();
    const blob = e.data;
    chain = chain.then(async () => {
      if (writeError) return;
      try {
        // Bytes, not the Blob: a Blob's data sits in the browser process until its small JS wrapper is
        // garbage-collected, which a quiet recorder page rarely does. ArrayBuffers count toward this
        // page's heap, so collection keeps up — and they are handed to the writer without a copy.
        await writer.write(await blob.arrayBuffer());
      } catch (err) {
        writeError = err;
        stop("disk");
      }
    });
  };
  // The encoder can fail (GPU process gone, unsupported size): stop and save what there is, and say so.
  recorder.onerror = () => stop("error");
  recorder.addEventListener("stop", () => {
    if (rec && rec.recorder === recorder && !rec.stopping) stop("error");
  });

  const limitMs = m.pro ? Infinity : m.limitMs;
  const limiter = createLimiter({ limitMs, timeScale: TIME_SCALE, onLimit: () => stop("limit") });
  rec = { recorder, streams, audioCtx, pipe, writer, rawName, fmt, limiter, stopping: null, stamp, gotData, setPaused: (v) => (paused = v), started: false, chain: () => chain };
  video.addEventListener("ended", () => stop("ended"));
  // If "go" never comes (the service worker was stopped while the picker was open), don't capture forever.
  setTimeout(() => {
    if (rec && rec.stamp === stamp && !rec.started) abort();
  }, 120_000);
  // Screen with Sound on, but the share window's "Share system audio" was off: no computer sound.
  const noSystemSound = m.mode === "screen" && !!m.sound && !soundStream;
  return { format: fmt.ext, width: out.width, height: out.height, micBlocked, noSystemSound };
}

function go() {
  if (!rec || rec.started) return;
  rec.started = true;
  rec.recorder.start(1000);
  rec.limiter.start();
}

function pause() {
  if (rec && rec.recorder.state === "recording") {
    rec.recorder.pause();
    rec.setPaused(true);
    rec.limiter.pause();
  }
}
function resume() {
  if (rec && rec.recorder.state === "paused") {
    rec.setPaused(false);
    rec.recorder.resume();
    rec.limiter.resume();
  }
}

function release(r) {
  for (const s of r.streams) s.getTracks().forEach((t) => t.stop());
  r.pipe.track.stop();
  if (r.audioCtx) r.audioCtx.close().catch(() => {});
}

/** Stop capturing without saving (cancelled countdown, lost service worker). */
async function abort() {
  const r = rec;
  if (!r) return;
  rec = null;
  r.limiter.stop();
  if (r.recorder.state !== "inactive") r.recorder.stop();
  release(r);
  await r.writer.close().catch(() => {});
  await clearAll();
}

function stop(reason = "user") {
  if (!rec) return Promise.resolve(null);
  if (rec.stopping) return rec.stopping;
  const r = rec;
  r.stopping = (async () => {
    r.limiter.stop();
    // The encoder needs a moment on the very first recording; a quick Stop waits for its first output (max 3 s).
    if (r.recorder.state !== "inactive") await Promise.race([r.gotData, new Promise((res) => setTimeout(res, 3000))]);
    if (r.recorder.state !== "inactive") {
      const stopped = new Promise((res) => r.recorder.addEventListener("stop", res, { once: true }));
      r.recorder.stop();
      await stopped;
    }
    release(r);
    await r.chain();
    await r.writer.close().catch(() => {});
    rec = null;
    toSw({ type: "rec:stopping", reason, stamp: r.stamp });
    try {
      const saved = await finalise(r.rawName, r.fmt.ext);
      toSw({ type: "rec:saved", ...saved, reason, stamp: r.stamp, recordedMs: Math.round(r.limiter.elapsed()) });
    } catch (e) {
      toSw({ type: "rec:error", code: /too short/.test(e.message) ? "short" : "save", stamp: r.stamp });
    }
  })();
  return r.stopping;
}

/**
 * The repaired file as a Blob of slices of the raw file: no copy, near-instant even
 * for hours of video. If the repair fails, the raw recording is saved as it is
 * (it plays; only the length and seeking are missing) — never nothing.
 */
async function finalise(rawName, ext) {
  const raw = await fileOf(rawName);
  if (!raw.size) {
    await clearAll();
    throw new Error("too short");
  }
  let blob;
  let durationMs = null;
  let repaired = true;
  try {
    const plan = await (ext === "mp4" ? planMp4 : planWebm)(fileSource(raw));
    blob = partsToBlob(raw, plan.parts, typeOf(ext));
    durationMs = plan.durationMs;
  } catch (e) {
    if (/too short/.test(e.message)) {
      await clearAll();
      throw e;
    }
    blob = raw.slice(0, raw.size, typeOf(ext));
    repaired = false;
  }
  return { ...publish(rawName, blob), opfsName: rawName, ext, mime: typeOf(ext), durationMs, repaired };
}

const urls = new Map();
function publish(name, blob) {
  const url = URL.createObjectURL(blob);
  urls.set(url, name);
  return { url, size: blob.size };
}

// ---------------------------------------------------------------- Pro jobs (on the last saved recording)
/** The last recording as a Blob: repaired, then each trim applied in order. Nothing is copied. */
async function materialize({ opfsName, ext, trims = [] }) {
  const raw = await fileOf(opfsName);
  const plan = ext === "mp4" ? planMp4 : planWebm;
  let p = await plan(fileSource(raw));
  let blob = partsToBlob(raw, p.parts, typeOf(ext));
  for (const t of trims) {
    p = await plan(fileSource(blob), { trim: t });
    blob = partsToBlob(blob, p.parts, typeOf(ext));
  }
  return { blob, durationMs: p.durationMs };
}

async function trim({ last, startMs, endMs }) {
  const { blob, durationMs } = await materialize({ ...last, trims: [...(last.trims || []), { startMs, endMs }] });
  return { ...publish(last.opfsName, blob), durationMs };
}

const GIF_FPS = 10;
const GIF_MAX_MS = 30_000;
const GIF_MAX_W = 640;

async function makeGif({ last }) {
  const { blob } = await materialize(last);
  const url = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  v.src = url;
  const gifName = `gif-${Date.now()}.gif`;
  try {
    await Promise.race([
      new Promise((res, rej) => {
        v.onloadeddata = res;
        v.onerror = () => rej(new Error("video could not be read"));
      }),
      timeout(30_000, "opening the video"),
    ]);
    const to = Math.min(v.duration * 1000, GIF_MAX_MS);
    const scale = Math.min(1, GIF_MAX_W / v.videoWidth);
    const w = Math.max(2, Math.round(v.videoWidth * scale));
    const h = Math.max(2, Math.round(v.videoHeight * scale));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d", { willReadFrequently: true });
    const seek = (t) =>
      Promise.race([
        new Promise((res) => {
          v.onseeked = res;
          v.currentTime = t / 1000;
        }),
        timeout(15_000, "reading a frame"),
      ]);
    const times = [];
    for (let t = 0; t < to; t += 1000 / GIF_FPS) times.push(t);
    // Palette from up to 8 frames spread over the clip.
    const samples = [];
    const n = Math.min(8, times.length);
    for (let i = 0; i < n; i++) {
      await seek(times[Math.floor((i * times.length) / n)]);
      g.drawImage(v, 0, 0, w, h);
      const d = g.getImageData(0, 0, w, h).data;
      for (let p = 0; p < d.length; p += 4 * 37) samples.push(d[p], d[p + 1], d[p + 2], 255);
    }
    const fh = await (await dir()).getFileHandle(gifName, { create: true });
    const ws = await fh.createWritable();
    const enc = createGifEncoder({ width: w, height: h, palette: buildPalette(Uint8Array.from(samples)), sink: { write: (u8) => ws.write(u8) } });
    let done = 0;
    for (const t of times) {
      await seek(t);
      g.drawImage(v, 0, 0, w, h);
      await enc.addFrame(g.getImageData(0, 0, w, h).data, 100 / GIF_FPS);
      if (++done % 10 === 0) toSw({ type: "job:progress", job: "gif", fraction: done / times.length });
    }
    await enc.finish();
    await ws.close();
    const gif = await fileOf(gifName);
    return { ...publish(gifName, gif.slice(0, gif.size, "image/gif")), gifName, frames: times.length, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
    v.removeAttribute("src");
  }
}

async function share({ last, token, name }) {
  let current = token;
  const drive = createDrive({
    base: DRIVE_BASE,
    fetch: (...a) => fetch(...a),
    getToken: async () => {
      if (current) return current;
      const r = await chrome.runtime.sendMessage({ target: "sw", type: "drive:token" });
      if (!r || !r.token) throw new DriveError("auth", (r && r.error) || "Google sign-in didn't finish. Press Share to try again.");
      return (current = r.token);
    },
    dropToken: async (t) => {
      current = null;
      await chrome.runtime.sendMessage({ target: "sw", type: "drive:drop-token", token: t });
    },
    // Offscreen documents only have chrome.runtime: the folder id is kept by the service worker.
    folderCache: {
      get: async () => (await chrome.runtime.sendMessage({ target: "sw", type: "drive:folder" })).id || null,
      set: (id) => chrome.runtime.sendMessage({ target: "sw", type: "drive:folder", id }),
    },
  });
  const { blob } = await materialize(last);
  const res = await drive.share(blob, name, (fraction) => toSw({ type: "job:progress", job: "share", fraction }));
  return { link: res.link, private: res.private };
}

/** Free the blob: URLs; delete every file except `keep`. */
async function releaseFiles({ keep }) {
  for (const url of urls.keys()) URL.revokeObjectURL(url);
  urls.clear();
  await clearAll(keep ? [keep] : []);
}

/**
 * A raw recording left behind by a crash, an update or a closed browser: repair
 * it and hand it over for saving. Anything else left over is deleted, including
 * `skip` (a recording that was saved already and only kept for Pro jobs).
 */
async function recover({ skip = [] } = {}) {
  if (rec) return null;
  const d = await dir();
  const raws = [];
  for await (const [name, h] of d.entries()) {
    const m = /^rec-(\d+)\.(mp4|webm)\.raw$/.exec(name);
    if (m && h.kind === "file" && !skip.includes(name)) raws.push({ name, ext: m[2], stamp: Number(m[1]) });
  }
  raws.sort((a, b) => b.stamp - a.stamp);
  for (const r of raws) {
    try {
      const saved = await finalise(r.name, r.ext);
      await clearAll([r.name]);
      return { ...saved, stamp: r.stamp };
    } catch {
      /* unreadable: try the next one */
    }
  }
  await clearAll();
  return null;
}

// ---------------------------------------------------------------- messages
const handlers = {
  "rec:start": start,
  "rec:go": go,
  "rec:pause": pause,
  "rec:resume": resume,
  "rec:abort": abort,
  "rec:viewport": (m) => {
    if (rec && m.viewport && Number.isFinite(m.viewport.w) && Number.isFinite(m.viewport.h)) rec.pipe.setViewport({ w: m.viewport.w, h: m.viewport.h });
  },
  "rec:stop": (m) => {
    stop(m.reason || "user");
    return true;
  },
  "rec:state": () => (rec ? { state: rec.recorder.state, started: rec.started, stamp: rec.stamp } : { state: "none" }),
  "rec:recover": recover,
  "job:trim": trim,
  "job:gif": makeGif,
  "job:share": share,
  "job:release": releaseFiles,
};

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || m.target !== "offscreen" || !handlers[m.type]) return;
  // Only the service worker talks to the recorder — never a page's content script.
  if (sender.id !== chrome.runtime.id || sender.tab || sender.url !== SW_URL) return;
  // A job's answer also goes out as its own message: if the service worker was stopped during
  // a long job (a slow Share upload), the reply is lost but this message wakes the new worker.
  const finished = /^job:(trim|gif|share)$/.test(m.type)
    ? (ok, value, e) => toSw({ type: "job:finished", id: m.id, ok, value, error: e && e.message, kind: e && e.kind, startMs: m.startMs, endMs: m.endMs })
    : () => {};
  Promise.resolve()
    .then(() => handlers[m.type](m))
    .then(
      (v) => (finished(true, v), v),
      (e) => {
        finished(false, null, e);
        throw e;
      },
    )
    .then(
      (v) => reply({ ok: true, value: v === undefined ? null : v }),
      (e) => reply({ ok: false, error: (e && e.message) || String(e), kind: e && e.kind, quiet: !!(e && e.quiet) }),
    );
  return true;
});
