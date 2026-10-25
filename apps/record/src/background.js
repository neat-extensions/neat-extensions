// Neat Record service worker. Event-driven only: no alarms, no timers while
// idle. Recording state lives in chrome.storage.session so the worker can be
// stopped and restarted at any moment; the offscreen document (the recorder)
// exists only while a recording or a Pro job is running.
import app from "../app.config.js";
import { verifyLicence } from "../../../packages/engine/src/licence.js";
import { captureSize, MIN_BOX } from "./lib/crop.js";
import { presetById } from "./lib/presets.js";
import { normaliseSettings, fileName, licencePublicKey, isBrowserPage, trimmedName } from "./lib/format.js";
import { shouldShowLimitNote, dayKey } from "./lib/limiter.js";

const LICENCE_KEY = licencePublicKey(app);
const TEST_TOKEN = process.env.RECORD_TEST_TOKEN || "";
const AUTH_URL = process.env.RECORD_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const WEB_CLIENT_ID = process.env.RECORD_WEB_CLIENT_ID || app.oauthWebClientId;
const SIGN_IN_CANCELLED = "Google sign-in didn't finish. Press Share to try again.";
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
  busy: "This page is already being recorded or shared. Stop that first.",
  noSystemSound: "No computer sound: next time, turn on the system-audio switch in the share window.",
  held: "Your browser is still holding this page after the last try. Close this tab and open the page again, or pick Screen.",
  denied: "Your browser didn't allow the recording. Press Record and choose Share or Allow.",
  start: "The recording couldn't start. Try again.",
  short: "Too short to save. Record for at least a second.",
  save: "The recording couldn't be saved. Try again.",
  stopped: "The recorder stopped unexpectedly. What was recorded is saved.",
  disk: "Your disk is full. What was recorded is saved — free some space before the next one.",
  noSpace: "Your disk is full, so the video couldn't be saved. Free some space and press Save again.",
  cancelled: "Not saved yet. Press Save again to choose where.",
  download: "Your browser couldn't save the video. Press Save again.",
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

async function fileExists(name) {
  try {
    await (await navigator.storage.getDirectory()).getFileHandle(name);
    return true;
  } catch {
    return false;
  }
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

/** "busy" right after our own failed start on that tab means the browser kept its hold on the page: say how to get out. */
async function startError(e, tabId) {
  const code = friendlyStart(e);
  if (code !== "busy") return code;
  const { failedTab } = await chrome.storage.session.get("failedTab");
  return failedTab === tabId ? "held" : code;
}

function friendlyStart(e) {
  const m = String((e && e.message) || e);
  if ((e && e.kind === "page") || /Chrome pages cannot be captured|not been invoked|Cannot access|cannot be scripted/i.test(m)) return "page";
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
  // This page on the browser's own pages: some browsers allow the capture but send no picture.
  if (s.mode === "tab" && isBrowserPage(tab.url || tab.pendingUrl)) return { ok: false, error: SAY.page };
  const pro = await isPro();
  await clearDone(st);
  await badge(null);
  const injected = await inject(tab.id);
  if (s.mode === "box" && !injected) return { ok: false, error: SAY.boxPage };
  // The browser's own pages (New Tab, settings) hide their address from extensions and can't be
  // scripted; some browsers still "capture" them but send one frame at most. Refuse them up front.
  if (s.mode === "tab" && !injected && !tab.url) return { ok: false, error: SAY.page };
  // Tab: ask Chrome for the stream now, while the panel is open, so a refusal is shown right there.
  let streamId = null;
  if (s.mode === "tab") {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (e) {
      if (injected) toTab(tab.id, { type: "teardown" });
      return { ok: false, error: SAY[await startError(e, tab.id)] };
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
    // A page where nothing moves sends no picture until something repaints: make one invisible repaint now,
    // so the recorder has a first frame to show (and repeat) from the start.
    if ((s.mode === "tab" || s.mode === "box") && (await getState()).injected) await toTab(tabId, { type: "nudge" });
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
    await setState({ phase: "recording", startedAt: Date.now(), bankedMs: 0, paused: false, format: info.format, box: choice && choice.box, micBlocked: info.micBlocked, soundMissing: !!info.noSystemSound, toast: info.micBlocked ? SAY.micBlocked : info.noSystemSound ? SAY.noSystemSound : null, ...extras });
    await badge("rec");
    await chrome.storage.session.remove("failedTab");
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
    } else {
      // A failed start on a tab can leave the browser holding it (seen with Chrome's test switches).
      if (s.mode === "tab" || s.mode === "box") await chrome.storage.session.set({ failedTab: tabId });
      await fail(await startError(e, tabId));
    }
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
  await toOffscreen("rec:stop", { reason }).catch(async () => {
    // The recorder is gone (it crashed): what it wrote is still on disk, so recover it rather than fail.
    await closeOffscreen();
    if (st.injected) toTab(st.tabId, { type: "teardown" });
    await badge(null);
    await setState(IDLE, { replace: true });
    await recoverLeftovers();
    if ((await getState()).phase === "idle") await fail("save");
  });
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
  if (m.reason === "ended" && !note) {
    // The capture ended on its own: the recorded tab was closed, or the user pressed the browser's "Stop sharing".
    const tabGone = ["tab", "box"].includes(st.mode) && !(await chrome.tabs.get(st.tabId).catch(() => null));
    note = tabGone ? "Recording saved." : "You stopped sharing, so the recording stopped and was saved.";
  }
  if (!m.repaired) note = [note, "Saved without its index, so some players can't skip around in it."].filter(Boolean).join(" ");
  const last = { opfsName: m.opfsName, ext: m.ext, mime: m.mime, size: m.size, durationMs: m.durationMs, filename, recordedMs: m.recordedMs, trims: [], unindexed: !m.repaired };
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
    const pendingDownload = { id: null, then, url, filename };
    // A trimmed copy or GIF that won't save leaves the original's card working; "Save again" retries.
    if (then !== "saved") await setState({ phase: "done", job: null, unsaved: true, toast: SAY.download, pendingDownload });
    else await fail("download", { pendingDownload });
  }
}

async function onDownload(d) {
  const st = await getState();
  const p = st.pendingDownload;
  if (!p || p.id !== d.id || !d.state) return;
  if (d.state.current === "complete") {
    // The browser may have renamed it on a clash ("… (1).mp4"): show and reuse the name it really has.
    const [item] = await chrome.downloads.search({ id: d.id }).catch(() => []);
    const onDisk = item && item.filename ? item.filename.split(/[\\/]/).pop() : "";
    const stem = p.filename.replace(/\.[^.]+$/, "");
    const real = onDisk.startsWith(stem) ? onDisk : p.filename; // only our name, maybe with the browser's " (1)"
    const last = p.then === "gif" ? st.last : { ...st.last, downloadId: d.id, filename: real };
    await badge(st.injected ? null : "saved");
    const gif = st.last && st.last.durationMs > 30_000 ? "GIF of the first 30 seconds saved to Downloads" : "GIF saved to Downloads";
    const toast = p.then === "trim" ? "Trimmed copy saved to Downloads" : p.then === "gif" ? gif : st.toast;
    await setState({ phase: "done", pendingDownload: null, job: null, last, toast: p.then === "saved" && st.unsaved ? null : toast, gifId: p.then === "gif" ? d.id : st.gifId, unsaved: false });
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
  // Remembered across restarts (session state is not), so recovery never saves an already-saved file again,
  // and an extension update can bring the last recording back.
  await chrome.storage.local.set({ keptFile: keep, keptLast: keep ? { last: st.last, stamp: st.stamp } : null });
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

/** After a crash, an update or a browser restart: a recording left on disk is repaired and saved.
 *  The file kept for Pro jobs was saved already: it stays while its card is open, else it is deleted. */
async function recoverLeftovers({ keepLast = false } = {}) {
  let st = await getState();
  if (!["idle", "done", "error"].includes(st.phase)) return;
  const { keptFile = null, keptLast = null } = await chrome.storage.local.get(["keptFile", "keptLast"]);
  // After an update the session state is gone but the kept Pro file isn't: bring back "Last recording".
  if (keepLast && st.phase === "idle" && keptFile && keptLast && keptLast.last && keptLast.last.opfsName === keptFile && (await fileExists(keptFile))) {
    st = await setState({ phase: "done", stamp: keptLast.stamp, pro: await isPro(), injected: false, tabId: null, doneSeen: true, last: keptLast.last, note: null, toast: null, job: null, link: null }, { replace: true });
  }
  const live = st.phase === "done" && st.last ? st.last.opfsName : null;
  let found = false;
  try {
    const d = await navigator.storage.getDirectory();
    for await (const name of d.keys()) if (/\.raw$/.test(name) && name !== keptFile && name !== live) found = true;
  } catch {
    return;
  }
  if (!found) return wipeFiles(live);
  await ensureOffscreen();
  const r = await toOffscreen("rec:recover", { skip: [keptFile, live].filter(Boolean) }).catch(() => null);
  if (!r) {
    await closeOffscreen();
    return wipeFiles();
  }
  const pro = await isPro();
  const filename = fileName(app.productName, new Date(r.stamp), r.ext, " (recovered)");
  await setState({ phase: "saving", stamp: r.stamp, pro, injected: false, tabId: null, last: { opfsName: r.opfsName, ext: r.ext, mime: r.mime, size: r.size, durationMs: r.durationMs, filename, trims: [], unindexed: !r.repaired }, note: "A recording that was cut off has been saved.", toast: null, job: null }, { replace: true });
  await download(r.url, filename, "saved");
}

// ---------------------------------------------------------------- Pro jobs
/** Checks, then runs the job detached so the message queue stays free (the recorder may ask for a token mid-job). */
async function startJob(kind, m) {
  const st = await getState();
  if (st.phase !== "done" || !st.last) return { ok: false, error: "Nothing to work on yet." };
  if (st.last.unindexed) return { ok: false, error: "This recording was saved without its index, so it can't be shared, trimmed or made into a GIF." };
  if (st.job && (await chrome.offscreen.hasDocument())) return { ok: false, error: "busy" };
  if (!(await isPro())) return { ok: false, error: "pro" };
  if (kind === "trim" && !(Number.isFinite(m.startMs) && Number.isFinite(m.endMs) && m.endMs > m.startMs)) return { ok: false, error: "range" };
  await setState({ job: { kind, fraction: 0 }, toast: null, ...(kind === "share" ? { link: null } : {}) });
  job(kind, m, st).catch(() => {});
  return { ok: true };
}

// True while this worker is waiting for the recorder's answer to a job. If the worker was
// stopped meanwhile (a slow Share upload), that answer is lost: the recorder's "job:finished"
// message then wakes the new worker, which finishes the job instead.
let jobInFlight = false;

async function job(kind, m, st) {
  jobInFlight = true;
  try {
    await ensureOffscreen();
    const id = st.stamp + ":" + Date.now();
    await setState({ job: { ...(await getState()).job, id } });
    let r;
    if (kind === "trim") r = await toOffscreen("job:trim", { id, last: st.last, startMs: m.startMs, endMs: m.endMs });
    else if (kind === "gif") r = await toOffscreen("job:gif", { id, last: st.last });
    else if (kind === "share") {
      if (!TEST_TOKEN && /^OAUTH_CLIENT_ID/.test(chrome.runtime.getManifest().oauth2?.client_id || "OAUTH_CLIENT_ID")) throw Object.assign(new Error(SAY.notSetUp), { kind: "setup" });
      await setState({ job: { ...(await getState()).job, stage: "signin" } });
      const token = await getToken();
      await setState({ job: { ...(await getState()).job, stage: "upload" } });
      r = await toOffscreen("job:share", { id, last: st.last, token, name: st.last.filename });
    }
    await finishJob(kind, m, st, r);
  } catch (e) {
    await jobFailed(e);
  } finally {
    jobInFlight = false;
  }
}

async function finishJob(kind, m, st, r) {
  await setState({ job: { ...(await getState()).job, answered: true } });
  if (kind === "trim") {
    const filename = trimmedName(st.last.filename, st.last.ext, (st.last.trims || []).length + 1);
    await setState({ last: { ...st.last, trims: [...(st.last.trims || []), { startMs: m.startMs, endMs: m.endMs }], size: r.size, durationMs: r.durationMs, filename } });
    await download(r.url, filename, "trim");
  } else if (kind === "gif") {
    await download(r.url, st.last.filename.replace(/\.(mp4|webm)$/, ".gif"), "gif");
  } else if (kind === "share") {
    // Copied by the page the user pressed Share on (no clipboard permission needed); the panel and the card have Copy too.
    const now = await getState();
    const copied = now.injected ? (await toTab(now.tabId, { type: "copy", text: r.link })) === true : false;
    const toast = r.private ? "Uploaded, but your account doesn't allow public links: the link works only for you." : copied ? "Link copied — anyone with the link can watch" : "Link ready — press Copy. Anyone with the link can watch.";
    await setState({ job: null, link: r.link, toast });
    await afterJob();
  }
}

async function jobFailed(e) {
  const plain = ["offline", "auth", "quota", "busy", "forbidden", "setup"].includes(e.kind);
  await setState({ job: null, toast: plain ? e.message : SAY.job });
  await afterJob();
}

async function getToken() {
  // Test builds skip sign-in, unless a test asks for the web sign-in (against a fake Google).
  if (TEST_TOKEN && !(await chrome.storage.local.get("testWebSignIn")).testWebSignIn) return TEST_TOKEN;
  const { webToken } = await chrome.storage.session.get("webToken");
  if (webToken && webToken.exp > Date.now() + 60_000) return webToken.token;
  // Edge, Brave and Opera have no Chrome sign-in (getAuthToken fails at once there).
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const notChrome = !!navigator.brave || brands.some((b) => /Edge|Brave|Opera/i.test(b.brand));
  if (!TEST_TOKEN && !notChrome) {
    // Chrome's own sign-in first.
    try {
      const r = await chrome.identity.getAuthToken({ interactive: true, scopes: [app.driveScope] });
      const token = typeof r === "string" ? r : r && r.token;
      if (token) return token;
    } catch (e) {
      if (/did not approve|cancel|denied|closed/i.test(String((e && e.message) || e))) throw Object.assign(new Error(SIGN_IN_CANCELLED), { kind: "auth" });
      // Not available in this browser (Edge, Brave, …): sign in through Google's web page below.
    }
  }
  return webSignIn();
}

/** Google's sign-in page in a browser window (chrome.identity.launchWebAuthFlow): works in Edge and Brave too. */
async function webSignIn() {
  if (/^OAUTH_WEB_CLIENT_ID/.test(WEB_CLIENT_ID)) throw Object.assign(new Error("Share works in Google Chrome for now. In this browser it isn't switched on yet."), { kind: "setup" });
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({ client_id: WEB_CLIENT_ID, response_type: "token", redirect_uri: chrome.identity.getRedirectURL(), scope: app.driveScope, state, include_granted_scopes: "true" }).toString();
  let back;
  try {
    back = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch {
    throw Object.assign(new Error(SIGN_IN_CANCELLED), { kind: "auth" }); // the user closed the window
  }
  const p = new URLSearchParams(new URL(back).hash.slice(1));
  if (p.get("state") !== state || !p.get("access_token")) throw Object.assign(new Error(SIGN_IN_CANCELLED), { kind: "auth" });
  const token = p.get("access_token");
  await chrome.storage.session.set({ webToken: { token, exp: Date.now() + Number(p.get("expires_in") || 3600) * 1000 } });
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
    await setState({ paused: true, bankedMs: st.bankedMs + (st.startedAt ? Date.now() - st.startedAt : 0), startedAt: null });
  },
  resume: async () => {
    const st = await getState();
    if (st.phase !== "recording" || !st.paused) return;
    if (st.held) return setState({ paused: false }); // it carries on when the panel closes
    await toOffscreen("rec:resume");
    await setState({ paused: false, startedAt: Date.now() });
  },
  // The drawn box fills the page: there is no Stop bar; the panel says how to stop.
  "bar:none": async (_m, sender) => {
    const st = await getState();
    if (st.phase === "recording" && sender.tab && sender.tab.id === st.tabId) await setState({ barless: true });
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
    // Finish first; the card just stays. A job with no recorder behind it is over, though.
    if (st.phase === "saving" || (st.job && (await chrome.offscreen.hasDocument()))) return { ok: false, error: "busy" };
    // A saved recording stays reachable from the panel ("Last recording": Share, Trim, GIF) until the next
    // recording or a browser restart; closing the card only takes it off the page.
    if (st.phase === "done" && st.last && !st.unsaved) {
      if (st.injected && st.tabId) toTab(st.tabId, { type: "teardown" });
      await badge(null);
      await setState({ injected: false, doneSeen: true, toast: null });
      return;
    }
    await clearDone(st);
    await badge(null);
    await setState(IDLE, { replace: true });
  },
  // The panel has shown the "Saved" card once: later openings show the main screen.
  "done:seen": async () => {
    const st = await getState();
    if (["done", "error"].includes(st.phase) && !st.doneSeen) await setState({ doneSeen: true });
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
    if (typeof m.token !== "string") return;
    const { webToken } = await chrome.storage.session.get("webToken");
    if (webToken && webToken.token === m.token) await chrome.storage.session.remove("webToken");
    else if (!TEST_TOKEN) await chrome.identity.removeCachedAuthToken({ token: m.token }).catch(() => {});
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
    if (st.job && st.job.kind === m.job && Number.isFinite(m.fraction)) await setState({ job: { ...st.job, fraction: Math.max(0, Math.min(1, m.fraction)) } });
  },
  // The recorder's answer to a job, sent as well as the reply: only used when the reply was lost.
  "job:finished": async (m) => {
    const st = await getState();
    if (jobInFlight || !st.job || st.job.answered || st.job.id !== m.id || st.phase !== "done" || !st.last) return;
    if (!m.ok) return jobFailed(Object.assign(new Error(m.error || ""), { kind: m.kind }));
    await finishJob(st.job.kind, { startMs: m.startMs, endMs: m.endMs }, st, m.value);
  },
};

// Who may send what. Pages' content scripts run next to untrusted page code, so they get
// only the buttons a user can press; the recorder's messages must come from the recorder.
const FROM_PAGE = new Set(["box:chosen", "box:cancel", "bar:none", "page:gone", "viewport", "stop", "pause", "resume", "dismiss", "show", "save-again", "open-pro", "trim", "gif", "share", "state"]);
const FROM_RECORDER = new Set(["drive:token", "drive:folder", "drive:drop-token", "rec:stopping", "rec:saved", "rec:error", "job:progress", "job:finished"]);
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
    // Stop also cancels a box being drawn, the 3-2-1 or the screen picker.
    if (["recording", "choosing", "countdown", "starting"].includes(st.phase)) return stop("user");
    if (!(await isPro())) return chrome.action.openPopup().catch(() => {});
    if (["idle", "done", "error"].includes(st.phase)) {
      const r = await start({ tabId: tab && tab.id });
      // It can't start here (a chrome:// page, say): open the panel rather than do nothing.
      if (r && !r.ok) chrome.action.openPopup().catch(() => {});
    }
  });
});


// A browser restart ends any recording; a recording cut off by a crash is recovered.
chrome.runtime.onStartup.addListener(() =>
  serial(async () => {
    await chrome.storage.session.set({ rec: IDLE });
    await recoverLeftovers();
  }),
);
// An update or reload keeps the last recording reachable ("Last recording"); a browser restart doesn't (privacy page).
chrome.runtime.onInstalled.addListener((d) => serial(() => recoverLeftovers({ keepLast: d.reason === "update" })));

// The panel open during a Screen or Window recording would be in the video: hold the recording while it is open.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel" || !port.sender || port.sender.id !== chrome.runtime.id) return;
  serial(async () => {
    const st = await getState();
    if (st.phase !== "recording" || !["screen", "window"].includes(st.mode) || st.paused || st.held) return;
    await toOffscreen("rec:pause").catch(() => {});
    await setState({ held: true, bankedMs: st.bankedMs + (st.startedAt ? Date.now() - st.startedAt : 0), startedAt: null });
  });
  port.onDisconnect.addListener(() =>
    serial(async () => {
      const st = await getState();
      if (!st.held) return;
      if (st.phase === "recording" && !st.paused) {
        await toOffscreen("rec:resume").catch(() => {});
        await setState({ held: false, startedAt: Date.now() });
      } else await setState({ held: false });
    }),
  );
});
// Updates wait until nothing is being recorded.
chrome.runtime.onUpdateAvailable.addListener(() =>
  serial(async () => {
    const st = await getState();
    if (["idle", "done", "error"].includes(st.phase) && !st.job) chrome.runtime.reload();
  }),
);

// For the e2e-only entry point (src/test-hook.js); harmless in the shipped bundle.
export { handlers, getState, setState };
