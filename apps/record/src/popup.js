// The panel: pick what to record, a few switches, quality, one big Record button.
// While recording it shows the time and Stop; afterwards, the saved file.
import app from "../app.config.js";
import { licencePublicKey } from "./lib/format.js";
import { verifyLicence } from "../../../packages/engine/src/licence.js";
import { icon, h, mb } from "./lib/ui.js";
import { PRESETS, presetById, sizeLabel } from "./lib/presets.js";
import { normaliseSettings, clock } from "./lib/format.js";

const LICENCE_KEY = licencePublicKey(app);

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));

const MODES = [
  { id: "tab", label: "Tab", icon: "tab", title: "Record this tab" },
  { id: "window", label: "Window", icon: "window", title: "Record a window" },
  { id: "screen", label: "Screen", icon: "screen", title: "Record the whole screen" },
  { id: "box", label: "Draw a box", icon: "box", title: "Record part of this tab: drag a box" },
];
const TOGGLES = [
  { id: "mic", label: "Mic", icon: "mic", title: "Record your microphone" },
  { id: "sound", label: "Sound", icon: "sound", title: "Record the tab or computer sound" },
  { id: "camera", label: "Camera", icon: "camera", title: "Show your camera in a bubble", pro: true },
  { id: "clicks", label: "Clicks", icon: "click", title: "Highlight your clicks", pro: true },
  { id: "countdown", label: "3-2-1", icon: "countdown", title: "Count down before recording", pro: true },
];

let settings = normaliseSettings(null);
let pro = false;
let state = { phase: "idle" };
let tick = null;
const MAC = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");

async function load() {
  const [{ settings: raw }, { licence }, st] = await Promise.all([chrome.storage.local.get("settings"), chrome.storage.sync.get("licence"), send({ type: "state" })]);
  settings = normaliseSettings(raw);
  pro = !!licence && (await verifyLicence(LICENCE_KEY, licence, app.licenceProduct, { revoked: app.revokedLicences })).ok;
  state = st && st.phase ? st : { phase: "idle" };
}

const save = () => chrome.storage.local.set({ settings });
const openTab = (url) => chrome.tabs.create({ url }).then(() => window.close());
const openPro = () => openTab(chrome.runtime.getURL("pro.html"));

// ------------------------------------------------------------ idle panel
function buildIdle() {
  const modes = $("modes");
  for (const m of MODES) {
    const b = h("button", { class: "mode", role: "radio", "data-id": m.id, title: m.title, "aria-checked": "false" }, icon(m.icon, { size: 24 }), h("span", { text: m.label }));
    b.addEventListener("click", () => {
      $("message").classList.remove("error");
      settings.mode = m.id;
      save();
      paintIdle();
    });
    modes.append(b);
  }
  radioKeys(modes);

  const toggles = $("toggles");
  for (const t of TOGGLES) {
    const locked = t.pro && !pro;
    const b = h("button", { class: "toggle", "data-id": t.id, title: locked ? `${t.title} — Pro` : t.title, "aria-label": locked ? `${t.label} (Pro: opens the Pro page)` : t.label, "aria-pressed": "false" }, icon(t.icon, { size: 18 }), h("span", { text: t.label }), locked ? icon("lock", { size: 10, cls: "lock" }) : null);
    b.addEventListener("click", async () => {
      if (locked) return openPro();
      settings[t.id] = !settings[t.id];
      await save();
      paintIdle();
      // Chrome asks for the microphone/camera once, on a page of ours (a panel can't show its question).
      const name = t.id === "mic" ? "microphone" : t.id === "camera" ? "camera" : null;
      if (settings[t.id] && name && !(await permissionOk(name))) openTab(chrome.runtime.getURL(`allow.html?want=${t.id}`));
    });
    toggles.append(b);
  }

  const seg = $("quality");
  for (const p of PRESETS) {
    const b = h("button", { role: "radio", "data-id": p.id, "aria-checked": "false", title: p.pro && !pro ? `${p.label}: ${p.detail} — Pro` : `${p.label}: ${p.detail}`, "aria-label": p.pro && !pro ? `${p.label}, ${p.detail} (Pro: opens the Pro page)` : `${p.label}, ${p.detail}` }, p.label, p.pro && !pro ? icon("lock", { size: 10, cls: "lock" }) : null);
    b.addEventListener("click", () => {
      if (p.pro && !pro) return openPro();
      settings.quality = p.id;
      save();
      paintIdle();
    });
    seg.append(b);
  }
  radioKeys(seg);

  $("record").addEventListener("click", record);
  $("help").addEventListener("click", (e) => {
    e.preventDefault();
    openTab(app.helpUrl);
  });
  $("pro").addEventListener("click", (e) => {
    e.preventDefault();
    openPro();
  });
}

/** Arrow keys move through a radio group, as screen-reader users expect. */
function radioKeys(group) {
  group.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const items = [...group.querySelectorAll("[role=radio]")];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = items[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? items.length - 1 : 1)) % items.length];
    next.focus();
    next.click();
  });
}

function paintIdle() {
  for (const b of $("modes").children) {
    const on = b.dataset.id === settings.mode;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  // Window recordings carry no sound (Chrome can't capture one window's audio), nor does Screen on a Mac.
  const noSound = settings.mode === "window" || (settings.mode === "screen" && MAC);
  for (const b of $("toggles").children) {
    const t = TOGGLES.find((x) => x.id === b.dataset.id);
    b.setAttribute("aria-pressed", String(!!settings[t.id] && (!t.pro || pro) && !(t.id === "sound" && noSound)));
    if (t.id === "sound") {
      b.disabled = noSound;
      b.title = noSound ? (settings.mode === "window" ? "Chrome can't record one window's sound. Use Tab or Screen." : "A Mac doesn't share the computer's sound. Use Tab.") : t.title;
    }
  }
  const q = presetById(settings.quality, { pro });
  for (const b of $("quality").children) {
    const on = b.dataset.id === q.id;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $("quality-caption").textContent = `${q.detail} · ${sizeLabel(q)}${pro ? "" : ` · up to ${app.freeLimitMinutes} minutes`}`;
  // A quiet line on how to stop, until there's something more important to say.
  const msg = $("message");
  if (!msg.classList.contains("error")) msg.textContent = settings.mode === "box" ? "Drag a box on the page. Stop is next to it." : settings.mode === "tab" ? "To stop, click this icon again." : "To stop, click this icon or Chrome's “Stop sharing”.";
}

function paintPro() {
  const p = $("pro");
  p.textContent = pro ? "Pro ✓" : "Pro";
  p.classList.toggle("on", pro);
  p.title = pro ? "Pro is on" : `Get Pro — ${app.price} once`;
}

async function permissionOk(name) {
  try {
    return (await navigator.permissions.query({ name })).state === "granted";
  } catch {
    return false;
  }
}

function say(text) {
  const msg = $("message");
  msg.classList.add("error");
  msg.textContent = text;
}

async function record() {
  // Microphone and camera must be allowed once, on a normal page of ours (a popup can't show Chrome's prompt).
  const want = [];
  if (settings.mic && !(await permissionOk("microphone"))) want.push("mic");
  if (pro && settings.camera && !(await permissionOk("camera"))) want.push("camera");
  if (want.length) return openTab(chrome.runtime.getURL(`allow.html?want=${want.join(",")}`));
  $("record").disabled = true;
  const r = await send({ type: "start" });
  if (r && r.ok && r.close) return window.close();
  $("record").disabled = false;
  say((r && r.error) || "Couldn't start. Try again.");
}

// ------------------------------------------------------------ recording / saved
function buildLive() {
  $("stop").addEventListener("click", () => send({ type: "stop" }));
  $("pause").addEventListener("click", () => send({ type: state.paused ? "resume" : "pause" }));
}

function paintLive() {
  clearTimeout(tick);
  const saving = state.phase === "saving";
  const choosing = state.phase === "choosing" || state.phase === "starting" || state.phase === "countdown";
  $("live-label").textContent = saving ? "Saving…" : choosing ? (state.phase === "choosing" ? "Draw a box on the page" : "Starting…") : state.paused ? "Paused" : "Recording";
  const ms = (state.bankedMs || 0) + (state.paused || !state.startedAt ? 0 : Date.now() - state.startedAt);
  $("live-time").textContent = clock(ms);
  // Free: no Pause button at all while recording (no upsell mid-recording).
  $("pause").hidden = !pro;
  $("pause").replaceChildren(icon(state.paused ? "play" : "pause", { size: 18 }), state.paused ? "Resume" : "Pause");
  $("pause").disabled = state.phase !== "recording";
  const cancel = state.phase === "choosing" || state.phase === "starting" || state.phase === "countdown";
  $("stop").replaceChildren(icon(cancel ? "close" : "stop", { size: 18 }), cancel ? "Cancel" : "Stop");
  $("stop").disabled = saving;
  $("live-hint").textContent =
    state.phase === "choosing"
      ? "Or press Esc on the page."
      : state.micBlocked && state.phase === "recording"
        ? "Recording without the microphone (it's blocked)."
        : state.limitMs && state.phase === "recording"
          ? `Free recordings stop and save at ${clock(state.limitMs)}.`
          : "";
  if (state.phase === "recording" && !state.paused) tick = setTimeout(paintLive, 1000 - (ms % 1000) + 5);
}

function paintDone() {
  const err = state.phase === "error";
  $("done-title").textContent = err ? "Something went wrong" : state.unsaved ? "Not saved yet" : "Saved to Downloads";
  $("done-badge").replaceChildren(icon(err ? "close" : "check", { size: 18 }));
  $("done-badge").classList.toggle("err", err);
  const last = state.last;
  $("done-meta").textContent = last && !err ? `${clock(last.durationMs)} · ${mb(last.size)}` : "";
  const acts = $("done-actions");
  acts.replaceChildren();
  if (!err && last) {
    const btn = (name, label, type, locked) => {
      const b = h("button", { class: "act", disabled: !!state.job || (state.unsaved && type !== "save-again"), title: locked ? `${label} — Pro` : label, "aria-label": locked ? `${label} (Pro: opens the Pro page)` : label }, icon(name, { size: 18 }), label, locked ? icon("lock", { size: 10, cls: "lock" }) : null);
      b.addEventListener("click", () => (locked ? openPro() : type === "trim" ? trimPanel() : send({ type })));
      return b;
    };
    acts.append(state.unsaved ? btn("folder", "Save again", "save-again", false) : btn("folder", "Show file", "show", false), btn("link", "Share", "share", !pro), btn("scissors", "Trim", "trim", !pro), btn("gif", "GIF (30 s)", "gif", !pro));
  }
  $("done-toast").textContent = state.job ? (state.job.kind === "share" ? `Uploading… ${Math.round((state.job.fraction || 0) * 100)}%` : "Working…") : state.toast || state.note || "";
  $("done-linkrow").hidden = !state.link;
  if (state.link) $("done-link").value = state.link;
  $("new").textContent = err ? "Try again" : "Record again";
}

/** Trim, inside the panel: two sliders in whole seconds, then a trimmed copy is saved. */
function trimPanel() {
  const total = Math.max(1, Math.floor((state.last.durationMs || 0) / 1000));
  const s = h("input", { type: "range", min: 0, max: total, step: 1, value: 0, "aria-label": "Start" });
  const e = h("input", { type: "range", min: 0, max: total, step: 1, value: total, "aria-label": "End" });
  const label = h("p", { class: "caption" });
  const paintTrim = () => (label.textContent = `Keep ${clock(s.value * 1000)} to ${clock(e.value * 1000)}`);
  s.addEventListener("input", () => {
    if (Number(s.value) >= Number(e.value)) s.value = String(Number(e.value) - 1);
    paintTrim();
  });
  e.addEventListener("input", () => {
    if (Number(e.value) <= Number(s.value)) e.value = String(Number(s.value) + 1);
    paintTrim();
  });
  paintTrim();
  const save = h("button", { class: "act", text: "Save trimmed copy" });
  save.addEventListener("click", () => send({ type: "trim", startMs: Number(s.value) * 1000, endMs: Number(e.value) * 1000 }));
  const cancel = h("button", { class: "act", text: "Cancel" });
  cancel.addEventListener("click", paintDone);
  $("done-actions").replaceChildren(h("div", { class: "trim" }, h("label", {}, "Start", s), h("label", {}, "End", e), label), cancel, save);
  s.focus();
}

function paint() {
  paintPro();
  const live = ["starting", "choosing", "countdown", "recording", "saving"].includes(state.phase);
  const done = ["done", "error"].includes(state.phase);
  $("idle").hidden = live || done;
  $("live").hidden = !live;
  $("done").hidden = !done;
  if (live) paintLive();
  else if (done) paintDone();
  else paintIdle();
}

(async () => {
  await load();
  buildIdle();
  buildLive();
  // One press for the next recording: close the last one and start with the same settings.
  $("new").addEventListener("click", async () => {
    const r = await send({ type: "dismiss" });
    if (r && r.ok === false) return;
    state = { phase: "idle" };
    paint();
    record();
  });
  $("copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("done-link").value).catch(() => {});
    $("done-toast").textContent = "Link copied — anyone with the link can watch";
  });
  paint();
  document.body.classList.add("ready");
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "session" && c.rec) {
      state = c.rec.newValue || { phase: "idle" };
      paint();
    }
    if (area === "sync" && c.licence) location.reload();
  });
})();
