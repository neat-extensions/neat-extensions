// Small shared helpers: output format choice, file names, settings defaults.
import { DEFAULT_PRESET } from "./presets.js";

/** The H.264 level that fits a frame size (macroblocks per frame): 4.0, 4.2, 5.0 or 5.1. */
export function avcLevel(width, height) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  return mbs <= 8192 ? "28" : mbs <= 8704 ? "2a" : mbs <= 22080 ? "32" : "33";
}

/** The browser's own pages (settings, version, new tab, extension pages): no picture can be recorded from them. */
export function isBrowserPage(url) {
  return /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|extension|devtools|view-source|chrome-search):/i.test(url || "");
}

/** MP4 (H.264/AAC) when Chrome can record it, else WebM (VP9/Opus, then VP8). */
export function pickFormat(hasAudio, width, height, isSupported) {
  const avc = `avc1.6400${avcLevel(width, height)}`;
  const options = [
    { mime: `video/mp4;codecs=${avc}${hasAudio ? ",mp4a.40.2" : ""}`, ext: "mp4", type: "video/mp4" },
    { mime: `video/mp4;codecs=avc1.42E01E${hasAudio ? ",mp4a.40.2" : ""}`, ext: "mp4", type: "video/mp4" },
    { mime: `video/webm;codecs=vp9${hasAudio ? ",opus" : ""}`, ext: "webm", type: "video/webm" },
    { mime: `video/webm;codecs=vp8${hasAudio ? ",opus" : ""}`, ext: "webm", type: "video/webm" },
  ];
  return options.find((o) => isSupported(o.mime)) || { mime: "video/webm", ext: "webm", type: "video/webm" };
}

/** "Neat Record 2026-10-23 at 14.05.32.mp4" — sorts by date, no characters Windows refuses. */
export function fileName(product, d, ext, suffix = "") {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  return `${product} ${date} at ${time}${suffix}.${ext}`.replace(/[\\/:*?"<>|]/g, "-");
}

// In the order people see them. "tab" is shown as "This page".
export const MODES = ["box", "screen", "window", "tab"];

export const DEFAULT_SETTINGS = { mode: "box", mic: false, sound: true, quality: DEFAULT_PRESET, camera: false, clicks: false, countdown: false };

export function normaliseSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const bool = (k) => (typeof s[k] === "boolean" ? s[k] : DEFAULT_SETTINGS[k]);
  return {
    mode: MODES.includes(s.mode) ? s.mode : DEFAULT_SETTINGS.mode,
    mic: bool("mic"),
    sound: bool("sound"),
    quality: ["good", "better", "best"].includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
    camera: bool("camera"),
    clicks: bool("clicks"),
    countdown: bool("countdown"),
  };
}

/** m:ss or h:mm:ss */
export function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The shipped licence public key; an e2e build may swap in a throwaway test key (never a release build). */
export function licencePublicKey(app) {
  const o = process.env.RECORD_LICENCE_PUBLIC_KEY;
  return o ? JSON.parse(o) : app.licencePublicKey;
}
