// Neat Record service worker. Event-driven only: no alarms, no timers while
// idle. Recording state lives in chrome.storage.session so the worker can be
// stopped and restarted at any moment; the offscreen document (the recorder)
// exists only while a recording or a Pro job is running.
import app from "../app.config.js";
import { verifyLicence } from "../../../packages/engine/src/licence.js";
import { captureSize, MIN_BOX } from "./lib/crop.js";
import { presetById } from "./lib/presets.js";
import { normaliseSettings, fileName, licencePublicKey } from "./lib/format.js";
import { shouldShowLimitNote, dayKey } from "./lib/limiter.js";

const LICENCE_KEY = licencePublicKey(app);
const TEST_TOKEN = process.env.RECORD_TEST_TOKEN || "";
const OFFSCREEN = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN);
const LIMIT = `${app.freeLimitMinutes}:00`;
const LIMIT_NOTE = `Saved. Pro removes the ${app.freeLimitMinutes}-minute limit`;
const IDLE = { phase: "idle" };
const BLOB_PREFIX = `blob:chrome-extension://${chrome.runtime.id}/`;

// Plain sentences for everything that can go wrong. Exception text never reaches the user.
const SAY = {
  page: "This page can't be recorded. Open a normal web page, or pick Window or Screen.",
  boxPage: "Draw a box works on normal web pages. Open one, or pick Window or Screen.",
  busy: "This tab is already being recorded or shared. Stop that first.",
  denied: "Chrome didn't allow the recording. Press Record and choose Share or Allow.",
  start: "The recording couldn't start. Try again.",
  short: "Too short to save. Record for at least a second.",
  save: "The recording couldn't be saved. Try again.",
  stopped: "The recorder stopped unexpectedly. What was recorded is saved.",
  disk: "Your disk is full. What was recorded is saved — free some space before the next one.",
  noSpace: "Your disk is full, so the video couldn't be saved. Free some space and press Save again.",
  cancelled: "Not saved yet. Press Save again to choose where.",
  download: "Chrome couldn't save the video. Press Save again.",
  job: "That didn't work. Try again.",
  notSetUp: "Share isn't switched on in this copy yet.",
  micBlocked: "Recording without the microphone (it's blocked).",
};

// ---------------------------------------------------------------- state
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function getState() {
  const { rec } = await chrome.storage.session.get("rec");
  return rec || IDLE;
}
// Every write is a read-merge-write under one lock, so concurrent patches never lose each other.
let stateLock = Promise.resolve();
function setState(patch, { replace = false } = {}) {
  const run = async () => {
    const next = replace ? patch : { ...(await getState()), ...patch };
    await chrome.storage.session.set({ rec: next });
    if (next.tabId && next.injected) chrome.tabs.sendMessage(next.tabId, { type: "state", state: next }).catch(() => {});
    return next;
  };
  const p = stateLock.then(run, run);
  stateLock = p.catch(() => {});
  return p;
}
async function settings() {
  return normaliseSettings((await chrome.storage.local.get("settings")).settings);
}

let proCache = { key: null, ok: false };
async function isPro() {
  const { licence } = await chrome.storage.sync.get("licence");
  if (!licence) return false;
  if (proCache.key !== licence) proCache = { key: licence, ok: (await verifyLicence(LICENCE_KEY, licence, app.licenceProduct, { revoked: app.revokedLicences })).ok };
  return proCache.ok;
}

// ---------------------------------------------------------------- offscreen
let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen
    .createDocument({ url: OFFSCREEN, reasons: ["USER_MEDIA", "DISPLAY_MEDIA", "BLOBS", "WORKERS"], justification: "Records the tab or screen the user chose and saves the video to their computer." })
    .finally(() => (creating = null));
  await creating;
}
async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
}
async function toOffscreen(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type, ...data });
  if (!r || !r.ok) throw Object.assign(new Error((r && r.error) || "recorder did not answer"), { quiet: r && r.quiet, kind: r && r.kind });
  return r.value;
}

/** Delete recorder files (all, or all but `keep`) without waking the recorder. */
async function wipeFiles(keep = null) {
  try {
    const d = await navigator.storage.getDirectory();
    for await (const name of d.keys()) if (name !== keep) await d.removeEntry(name).catch(() => {});
  } catch {
    /* storage unavailable: the recorder clears it at the next start */
  }
}

// ---------------------------------------------------------------- page UI (box overlay, bar, saved card)
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch {
    return false; // chrome:// pages, the Web Store, PDFs: no page UI there; the panel has the controls.
  }
}
const toTab = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => null);

async function badge(kind) {
  const look = { rec: ["REC", "#D6363C"], error: ["!", "#D6363C"], saved: ["✓", "#18794E"] }[kind];
  if (look) await chrome.action.setBadgeBackgroundColor({ color: look[1] });
  await chrome.action.setBadgeText({ text: look ? look[0] : "" });
}

async function fail(code, extra = {}) {
  const st = await getState();
  await badge(st.injected ? null : "error");
  await setState({ phase: "error", toast: SAY[code] || SAY.start, pendingDownload: null, job: null, ...extra });
}

// ---------------------------------------------------------------- start
async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t;
}

/** A state that says "busy" but has no recorder behind it (worker or recorder was stopped): reset it. */
async function healStuck(st) {
  if (["idle", "done", "error"].includes(st.phase)) return st;
  if (st.phase === "choosing") return st;
  const alive = (await chrome.offscreen.hasDocument()) && (await toOffscreen("rec:state").catch(() => ({ state: "none" })));
  if (alive && alive.state !== "none") return st;
  if (st.phase === "saving" && alive) return st;
  await closeOffscreen();
  await badge(null);
  await setState(IDLE, { replace: true });
  await recoverLeftovers();
  return getState();
}

function friendlyStart(e) {
  const m = String((e && e.message) || e);
  if (/Chrome pages cannot be captured|not been invoked|Cannot access|cannot be scripted/i.test(m)) return "page";
  if (/active stream/i.test(m)) return "busy";
  if (/Permission|NotAllowed/i.test(m)) return "denied";
  return "start";
}

async function start({ tabId } = {}) {
  let st = await healStuck(await getState());
  if (!["idle", "done", "error"].includes(st.phase)) return { ok: false, error: st.phase === "choosing" ? "Finish drawing the box on the page, or press Cancel." : "A recording is already running." };
  const tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : await activeTab();
  if (!tab) return { ok: false, error: "No tab to record." };
  const s = await settings();
  const pro = await isPro();
  await clearDone(st);
  await badge(null);
  const injected = await inject(tab.id);
  if (s.mode === "box" && !injected) return { ok: false, error: SAY.boxPage };
  // Tab: ask Chrome for the stream now, while the panel is open, so a refusal is shown right there.
  let streamId = null;
  if (s.mode === "tab") {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (e) {
      if (injected) toTab(tab.id, { type: "teardown" });
      return { ok: false, error: SAY[friendlyStart(e)] };
    }
  }
  const stamp = Date.now();
  await setState({ phase: s.mode === "box" ? "choosing" : "starting", stamp, mode: s.mode, tabId: tab.id, pro, injected, startedAt: null, bankedMs: 0, paused: false, note: null, last: null, job: null, toast: null, link: null, micBlocked: false, limitMs: pro ? null : app.freeLimitMinutes * 60_000, quality: s.quality }, { replace: true });
  if (s.mode === "box") {
    toTab(tab.id, { type: "overlay:select", presetHeight: presetById(s.quality, { pro }).height });
    return { ok: true, close: true }; // the panel closes so the user can drag the box
  }
  begin(tab.id, s, pro, null, stamp, streamId).catch(() => {});
  return { ok: true, close: true };
}

/** After the box is chosen (or straight away for the other modes): capture, countdown, record. */
async function begin(tabId, s, pro, choice, stamp, streamId = null) {
  const current = async () => {
    const st = await getState();
    return st.stamp === stamp ? st : null;
  };
  try {
    const preset = presetById(s.quality, { pro });
    let size = null;
    let viewport = null;
    if (s.mode === "tab" || s.mode === "box") {
      streamId ||= await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const v = choice ? choice.viewport : (await toTab(tabId, { type: "viewport" })) || (await viewportOf(tabId));
      viewport = { w: v.w, h: v.h };
      size = captureSize(v.w, v.h, v.dpr || 1, preset.height, choice ? choice.box : null);
    }
    await ensureOffscreen();
    const info = await toOffscreen("rec:start", { mode: s.mode, streamId, captureSize: size, viewport, box: choice && choice.box, quality: s.quality, mic: s.mic, sound: s.sound, pro, limitMs: app.freeLimitMinutes * 60_000, stamp });
    let st = await current();
    if (!st) return toOffscreen("rec:abort").catch(() => {});
    const extras = pro ? { camera: s.camera, clicks: s.clicks } : {};
    if (pro && s.countdown && st.injected) {
      await setState({ phase: "countdown", box: choice && choice.box, ...extras });
      await toTab(tabId, { type: "countdown", box: choice && choice.box });
      st = await current();
      if (!st || st.phase !== "countdown") return; // cancelled during 3-2-1
    }
    await toOffscreen("rec:go");
    await setState({ phase: "recording", startedAt: Date.now(), bankedMs: 0, paused: false, format: info.format, box: choice && choice.box, micBlocked: info.micBlocked, toast: info.micBlocked ? SAY.micBlocked : null, ...extras });
    await badge("rec");
  } catch (e) {
    console.warn("recording did not start:", e && e.message); // for the developer console; users get a plain sentence
    await toOffscreen("rec:abort").catch(() => {});
    await closeOffscreen();
    const st = await current();
    if (!st) return;
    if (e && (e.quiet || e.message === "cancelled")) {
      if (st.injected) toTab(tabId, { type: "teardown" });
      await badge(null);
      await setState(IDLE, { replace: true });
    } else await fail(friendlyStart(e));
  }
}

/** Pages without the page UI: size from the tab itself, device pixels unknown. */
async function viewportOf(tabId) {
  const t = await chrome.tabs.get(tabId).catch(() => null);
  return { w: (t && t.width) || 1280, h: (t && t.height) || 720, dpr: 1 };
}

// ---------------------------------------------------------------- stop / save
async function stop(reason = "user") {
  const st = await getState();
  if (st.phase === "choosing") return cancelBox();
  if (!["recording", "countdown", "starting"].includes(st.phase)) return;
  if (st.phase !== "recording") {
    // Nothing recorded yet (3-2-1 or the screen picker): Stop just cancels.
    await toOffscreen("rec:abort").catch(() => {});
    await closeOffscreen();
    if (st.injected) toTab(st.tabId, { type: "teardown" });
    await badge(null);
    await setState(IDLE, { replace: true });
    return;
  }
  await setState({ phase: "saving" });
  await toOffscreen("rec:stop", { reason }).catch(() => fail("save"));
}

async function cancelBox() {
  const st = await getState();
  if (st.phase !== "choosing") return;
  if (st.injected) toTab(st.tabId, { type: "teardown" });
  await setState(IDLE, { replace: true });
}

async function onSaved(m) {
  const st = await getState();
  if (st.stamp !== m.stamp) return; // a recording the user has already moved on from
  const filename = fileName(app.productName, new Date(m.stamp), m.ext);
  let note = null;
  if (m.reason === "limit" && !st.pro) {
    const { limitNoteDay } = await chrome.storage.local.get("limitNoteDay");
    const today = dayKey();
    if (shouldShowLimitNote(limitNoteDay, today)) {
      note = LIMIT_NOTE;
      await chrome.storage.local.set({ limitNoteDay: today });
    } else note = `Stopped at ${LIMIT}.`;
  }
  if (m.reason === "disk") note = SAY.disk;
  if (m.reason === "error") note = SAY.stopped;
  if (m.reason === "ended" && !note) note = "Sharing ended, so the recording stopped.";
  if (!m.repaired) note = [note, "Saved without its index, so some players can't skip around in it."].filter(Boolean).join(" ");
  const last = { opfsName: m.opfsName, ext: m.ext, mime: m.mime, size: m.size, durationMs: m.durationMs, filename, recordedMs: m.recordedMs, trims: [] };
  await setState({ phase: "saving", last, note, toast: st.micBlocked ? "Recorded without the microphone (it was blocked)." : st.toast === SAY.micBlocked ? null : st.toast });
  await download(m.url, filename, "saved");
}

/** Save a blob: URL from the recorder to Downloads; completion is handled by onDownload. */
async function download(url, filename, then) {
  if (typeof url !== "string" || !url.startsWith(BLOB_PREFIX)) return fail("save");
  try {
    const id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    await setState({ pendingDownload: { id, then, url, filename } });
    // A small file can finish before the line above lands: look once.
    const [d] = await chrome.downloads.search({ id });
    if (d && (d.state === "complete" || d.state === "interrupted")) await onDownload({ id, state: { current: d.state }, error: d.error ? { current: d.error } : undefined });
  } catch {
    await fail("download", { pendingDownload: { id: null, then, url, filename } });
  }
}

async function onDownload(d) {
  const st = await getState();
  const p = st.pendingDownload;
  if (!p || p.id !== d.id || !d.state) return;
  if (d.state.current === "complete") {
    const last = p.then === "gif" ? st.last : { ...st.last, downloadId: d.id };
    await badge(st.injected ? null : "saved");
    const toast = p.then === "trim" ? "Trimmed copy saved to Downloads" : p.then === "gif" ? "GIF saved to Downloads" : st.toast;
    await setState({ phase: "done", pendingDownload: null, job: null, last, toast, gifId: p.then === "gif" ? d.id : st.gifId, unsaved: false });
    await afterJob();
  } else if (d.state.current === "interrupted") {
    // Keep the file and its link: "Save again" retries. (A cancelled "Save as" dialog lands here too.)
    const err = (d.error && d.error.current) || "";
    const code = /USER_CANCELED/.test(err) ? "cancelled" : /FILE_NO_SPACE|FILE_TOO_LARGE/.test(err) ? "noSpace" : "download";
    await badge(st.injected ? null : "error");
    await setState({ phase: "done", job: null, unsaved: true, toast: SAY[code], pendingDownload: { ...p, id: null } });
  }
}
chrome.downloads.onChanged.addListener((d) => serial(() => onDownload(d)));

/** Free: forget the file now. Pro: keep only the last recording (for Share, Trim, GIF) until the card is closed. */
async function afterJob() {
  const st = await getState();
  const keep = st.pro && st.last ? st.last.opfsName : null;
  if (await chrome.offscreen.hasDocument()) {
    await toOffscreen("job:release", { keep }).catch(() => {});
    await closeOffscreen();
  }
  await wipeFiles(keep);
}

async function clearDone(st) {
  if (["done", "error"].includes(st.phase)) {
    if (st.injected && st.tabId) toTab(st.tabId, { type: "teardown" });
    await closeOffscreen();
    await wipeFiles();
  }
}

/** After a crash, an update or a browser restart: a recording left on disk is repaired and saved. */
async function recoverLeftovers() {
  const st = await getState();
  if (!["idle", "done", "error"].includes(st.phase)) return;
  let found = false;
  try {
    const d = await navigator.storage.getDirectory();
    for await (const name of d.keys()) if (/\.raw$/.test(name)) found = true;
  } catch {
    return;
  }
  if (!found) return wipeFiles();
  await ensureOffscreen();
  const r = await toOffscreen("rec:recover").catch(() => null);
  if (!r) {
    await closeOffscreen();
    return wipeFiles();
  }
  const pro = await isPro();
  const filename = fileName(app.productName, new Date(r.stamp), r.ext, " (recovered)");
  await setState({ phase: "saving", stamp: r.stamp, pro, injected: false, tabId: null, last: { opfsName: r.opfsName, ext: r.ext, mime: r.mime, size: r.size, durationMs: r.durationMs, filename, trims: [] }, note: "A recording that was cut off has been saved.", toast: null, job: null }, { replace: true });
  await download(r.url, filename, "saved");
}

// ---------------------------------------------------------------- Pro jobs
/** Checks, then runs the job detached so the message queue stays free (the recorder may ask for a token mid-job). */
async function startJob(kind, m) {
  const st = await getState();
  if (st.phase !== "done" || !st.last) return { ok: false, error: "Nothing to work on yet." };
  if (st.job) return { ok: false, error: "busy" };
  if (!(await isPro())) return { ok: false, error: "pro" };
  if (kind === "trim" && !(Number.isFinite(m.startMs) && Number.isFinite(m.endMs) && m.endMs > m.startMs)) return { ok: false, error: "range" };
  await setState({ job: { kind, fraction: 0 }, toast: null, ...(kind === "share" ? { link: null } : {}) });
  job(kind, m, st).catch(() => {});
  return { ok: true };
}

async function job(kind, m, st) {
  try {
    await ensureOffscreen();
    if (kind === "trim") {
      const r = await toOffscreen("job:trim", { last: st.last, startMs: m.startMs, endMs: m.endMs });
      const filename = st.last.filename.replace(/( \(trimmed\))?\.(mp4|webm)$/, ` (trimmed).${st.last.ext}`);
      await setState({ last: { ...st.last, trims: [...(st.last.trims || []), { startMs: m.startMs, endMs: m.endMs }], size: r.size, durationMs: r.durationMs, filename } });
      await download(r.url, filename, "trim");
    } else if (kind === "gif") {
      const r = await toOffscreen("job:gif", { last: st.last });
      await download(r.url, st.last.filename.replace(/\.(mp4|webm)$/, ".gif"), "gif");
    } else if (kind === "share") {
      if (!TEST_TOKEN && /^OAUTH_CLIENT_ID/.test(chrome.runtime.getManifest().oauth2?.client_id || "OAUTH_CLIENT_ID")) throw Object.assign(new Error(SAY.notSetUp), { kind: "setup" });
      const token = await getToken();
      const r = await toOffscreen("job:share", { last: st.last, token, name: st.last.filename });
      // Copied by the page the user pressed Share on (no clipboard permission needed); the panel and the card have Copy too.
      const now = await getState();
      const copied = now.injected ? (await toTab(now.tabId, { type: "copy", text: r.link })) === true : false;
      const toast = r.private ? "Uploaded, but your account doesn't allow public links: the link works only for you." : copied ? "Link copied — anyone with the link can watch" : "Link ready — press Copy. Anyone with the link can watch.";
      await setState({ job: null, link: r.link, toast });
      await afterJob();
    }
  } catch (e) {
    const plain = ["offline", "auth", "quota", "busy", "forbidden", "setup"].includes(e.kind);
    await setState({ job: null, toast: plain ? e.message : SAY.job });
    await afterJob();
  }
}

async function getToken() {
  if (TEST_TOKEN) return TEST_TOKEN;
  const r = await chrome.identity.getAuthToken({ interactive: true, scopes: [app.driveScope] }).catch(() => null);
  const token = typeof r === "string" ? r : r && r.token;
  if (!token) throw Object.assign(new Error("Google sign-in was cancelled. Press Share and click Allow."), { kind: "auth" });
  return token;
}

// ---------------------------------------------------------------- messages
const handlers = {
  start: (m) => start(m),
  stop: () => stop("user"),
  "box:cancel": () => cancelBox(),
  // The page with our UI is going away (reload, navigation, closed tab). No global tab listener needed.
  "page:gone": async (_m, sender) => {
    const st = await getState();
    if (!sender.tab || sender.tab.id !== st.tabId) return;
    if (st.phase === "choosing") await setState(IDLE, { replace: true });
    else if (st.injected) await setState({ injected: false });
  },
  pause: async () => {
    const st = await getState();
    if (st.phase !== "recording" || st.paused || !(await isPro())) return;
    await toOffscreen("rec:pause");
    await setState({ paused: true, bankedMs: st.bankedMs + (Date.now() - st.startedAt), startedAt: null });
  },
  resume: async () => {
    const st = await getState();
    if (st.phase !== "recording" || !st.paused) return;
    await toOffscreen("rec:resume");
    await setState({ paused: false, startedAt: Date.now() });
  },
  "box:chosen": async (m, sender) => {
    const st = await getState();
    if (st.phase !== "choosing" || !sender.tab || sender.tab.id !== st.tabId) return;
    const b = m.box;
    const v = m.viewport;
    const ok = b && v && [b.x, b.y, b.w, b.h, v.w, v.h, v.dpr].every(Number.isFinite) && b.w >= MIN_BOX && b.h >= MIN_BOX && b.x >= 0 && b.y >= 0 && b.x + b.w <= v.w + 1 && b.y + b.h <= v.h + 1 && v.dpr > 0 && v.dpr <= 8;
    if (!ok) return cancelBox();
    await setState({ phase: "starting" });
    begin(st.tabId, await settings(), st.pro, { box: { x: b.x, y: b.y, w: b.w, h: b.h }, viewport: { w: v.w, h: v.h, dpr: v.dpr } }, st.stamp).catch(() => {});
  },
  // The recorded tab was resized or zoomed during a box recording: re-crop the same part of the page.
  viewport: async (m, sender) => {
    const st = await getState();
    const v = m.viewport;
    if (st.phase !== "recording" || st.mode !== "box" || !sender.tab || sender.tab.id !== st.tabId || !v || ![v.w, v.h].every(Number.isFinite)) return;
    await toOffscreen("rec:viewport", { viewport: { w: v.w, h: v.h } }).catch(() => {});
  },
  dismiss: async () => {
    const st = await getState();
    if (st.phase === "saving" || st.job) return { ok: false, error: "busy" }; // finish first; the card just stays
    await clearDone(st);
    await badge(null);
    await setState(IDLE, { replace: true });
  },
  show: async () => {
    const st = await getState();
    const id = st.gifId || (st.last && st.last.downloadId);
    if (id) chrome.downloads.show(id);
  },
  "save-again": async () => {
    const st = await getState();
    const p = st.pendingDownload;
    if (st.phase !== "done" || !st.unsaved || !p) return;
    if (!(await chrome.offscreen.hasDocument())) return fail("save");
    await download(p.url, p.filename, p.then);
  },
  "open-pro": async () => {
    const st = await getState();
    if (["recording", "countdown", "starting", "choosing"].includes(st.phase)) return; // never pull the user away mid-recording
    await chrome.tabs.create({ url: chrome.runtime.getURL("pro.html") });
  },
  trim: (m) => startJob("trim", m),
  gif: () => startJob("gif", {}),
  share: () => startJob("share"),
  state: () => getState(),
  // From the recorder (offscreen document) only.
  "drive:token": async () => {
    try {
      return { token: await getToken() };
    } catch (e) {
      return { error: e.message };
    }
  },
  "drive:folder": async (m) => {
    if (typeof m.id === "string" && /^[\w-]{10,200}$/.test(m.id)) await chrome.storage.local.set({ driveFolder: m.id });
    return { id: (await chrome.storage.local.get("driveFolder")).driveFolder || null };
  },
  "drive:drop-token": async (m) => {
    if (!TEST_TOKEN && typeof m.token === "string") await chrome.identity.removeCachedAuthToken({ token: m.token }).catch(() => {});
  },
  "rec:stopping": async (m) => {
    const st = await getState();
    if (st.stamp === m.stamp && st.phase === "recording") await setState({ phase: "saving" });
  },
  "rec:saved": (m) => onSaved(m),
  "rec:error": async (m) => {
    const st = await getState();
    if (st.stamp !== m.stamp) return;
    await closeOffscreen();
    await wipeFiles();
    await fail(m.code === "short" ? "short" : "save");
  },
  "job:progress": async (m) => {
    const st = await getState();
    if (st.job && st.job.kind === m.job && Number.isFinite(m.fraction)) await setState({ job: { kind: m.job, fraction: Math.max(0, Math.min(1, m.fraction)) } });
  },
};

// Who may send what. Pages' content scripts run next to untrusted page code, so they get
// only the buttons a user can press; the recorder's messages must come from the recorder.
const FROM_PAGE = new Set(["box:chosen", "box:cancel", "page:gone", "viewport", "stop", "pause", "resume", "dismiss", "show", "save-again", "open-pro", "trim", "gif", "share", "state"]);
const FROM_RECORDER = new Set(["drive:token", "drive:folder", "drive:drop-token", "rec:stopping", "rec:saved", "rec:error", "job:progress"]);
// Answered straight away, outside the queue: they never change the recording flow.
const UNQUEUED = new Set(["state", "drive:token", "drive:drop-token", "drive:folder", "job:progress"]);

function allowed(type, sender) {
  if (sender.id !== chrome.runtime.id) return false;
  if (FROM_RECORDER.has(type)) return !sender.tab && sender.url === OFFSCREEN_URL;
  if (sender.url && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return true; // the panel, the Pro page
  return FROM_PAGE.has(type); // a content script on a web page
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || m.target === "offscreen" || typeof m.type !== "string" || !Object.hasOwn(handlers, m.type)) return;
  if (!allowed(m.type, sender)) return;
  const run = () => handlers[m.type](m, sender);
  (UNQUEUED.has(m.type) ? Promise.resolve().then(run) : serial(run)).then(
    (v) => reply(v === undefined ? { ok: true } : v),
    () => reply({ ok: false, error: SAY.job }),
  );
  return true;
});

// Keyboard shortcut: start (Pro) or stop (anyone). Free and not recording: opens the panel.
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd !== app.command.id) return;
  serial(async () => {
    const st = await getState();
    if (st.phase === "recording") return stop("user");
    if (!(await isPro())) return chrome.action.openPopup().catch(() => {});
    if (["idle", "done", "error"].includes(st.phase)) return start({ tabId: tab && tab.id });
  });
});


// A browser restart ends any recording; a recording cut off by a crash is recovered.
chrome.runtime.onStartup.addListener(() =>
  serial(async () => {
    await chrome.storage.session.set({ rec: IDLE });
    await recoverLeftovers();
  }),
);
chrome.runtime.onInstalled.addListener(() => serial(() => recoverLeftovers()));
// Updates wait until nothing is being recorded.
chrome.runtime.onUpdateAvailable.addListener(() =>
  serial(async () => {
    const st = await getState();
    if (["idle", "done", "error"].includes(st.phase) && !st.job) chrome.runtime.reload();
  }),
);

// For the e2e-only entry point (src/test-hook.js); harmless in the shipped bundle.
export { handlers, getState, setState };
