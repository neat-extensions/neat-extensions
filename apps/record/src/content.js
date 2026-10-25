// In-page UI, injected on demand into the tab the user is recording (activeTab +
// scripting.executeScript with this file; never on its own, never on other pages).
// Everything lives in one closed shadow root: the draw-a-box overlay, the
// floating bar, the 3-2-1 countdown, click highlights, the webcam bubble and
// the "saved" card. It reads nothing from the page.
import { icon, h, mb } from "./lib/ui.js";
import { TOKENS } from "./lib/tokens.js";
import { normaliseDrag, MIN_BOX } from "./lib/crop.js";
import { clock } from "./lib/format.js";
import { BRAND_SLUG } from "../../../brand.config.js";

const TAG = `${BRAND_SLUG}-record-ui`;
const KEY = Symbol.for(TAG);

function main() {
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const host = document.createElement(TAG);
  host.style.cssText = "all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483647;";
  // Closed, so the page cannot read or click our controls (e2e builds open it for Playwright).
  // A copy left by an earlier load of the extension (reloaded or updated) can't work any more: replace it.
  for (const old of document.querySelectorAll(TAG)) old.remove();
  const root = host.attachShadow({ mode: process.env.RECORD_SHADOW === "open" ? "open" : "closed" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(TOKENS + CSS);
  root.adoptedStyleSheets = [sheet];
  document.documentElement.append(host);

  let state = { phase: "idle" };
  let bar = null;
  let barless = false; // the box leaves no room for the bar outside it: stop from the panel instead
  let card = null;
  let frame = null;
  let camera = null;
  let count = null;
  let tick = null;
  let clicksOn = false;
  let presetHeight = 1080;
  let resizeTimer = null;

  // ------------------------------------------------------------ messages
  chrome.runtime.onMessage.addListener(onMessage);
  function onMessage(m, _s, reply) {
    if (m.type === "viewport") reply({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio });
    else if (m.type === "nudge") nudge().then(() => reply(true));
    else if (m.type === "overlay:select") {
      presetHeight = Number(m.presetHeight) || 1080;
      selectBox();
    }
    else if (m.type === "countdown") {
      countdown(m.box).then(() => reply(true));
      return true;
    } else if (m.type === "state") render(m.state);
    else if (m.type === "teardown") teardown();
    else if (m.type === "copy" && typeof m.text === "string" && /^https:\/\/drive\.google\.com\//.test(m.text)) {
      navigator.clipboard.writeText(m.text).then(
        () => reply(true),
        () => reply(false),
      );
      return true;
    }
  }
  // Reload, navigation or a closed tab: tell the extension (so the panel never waits on a page that's gone).
  const onGone = () => send({ type: "page:gone" });
  addEventListener("pagehide", onGone);

  // ------------------------------------------------------------ draw a box
  function selectBox() {
    const layer = h("div", { class: "select", role: "dialog", "aria-label": "Draw a box around what you want to record" });
    const hint = h("div", { class: "hint" }, h("strong", { text: "Drag to draw a box" }), h("span", { text: "Enter: whole page · Esc: cancel" }));
    const sel = h("div", { class: "sel", hidden: true });
    const size = h("div", { class: "size" });
    sel.append(size);
    layer.append(hint, sel);
    root.append(layer);
    layer.tabIndex = -1;
    layer.focus({ preventScroll: true });
    let start = null;
    let box = null;

    const done = (chosen) => {
      removeEventListener("keydown", onKey, true);
      layer.remove();
      if (!chosen) return send({ type: "box:cancel" });
      // Two frames so the overlay is gone from the screen before capture starts.
      requestAnimationFrame(() => requestAnimationFrame(() => send({ type: "box:chosen", box: chosen, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } })));
    };
    const onKey = (e) => {
      if (!e.isTrusted) return; // the page can't cancel or choose for the user
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        done(e.key === "Enter" ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : null);
      }
    };
    addEventListener("keydown", onKey, true);
    layer.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !e.isTrusted) return;
      e.preventDefault();
      layer.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
      hint.hidden = true;
    });
    layer.addEventListener("pointermove", (e) => {
      if (!start || !e.isTrusted) return;
      box = normaliseDrag(start.x, start.y, e.clientX, e.clientY, innerWidth, innerHeight);
      sel.hidden = false;
      Object.assign(sel.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      // The size the video will really have: device pixels, capped by the quality setting.
      const k = Math.min(1, presetHeight / (box.h * devicePixelRatio || 1)) * devicePixelRatio;
      size.textContent = `${Math.round(box.w * k)} × ${Math.round(box.h * k)}`;
      size.classList.toggle("inside", box.y < 32);
    });
    layer.addEventListener("pointerup", (e) => {
      if (!start || !e.isTrusted) return;
      start = null;
      if (box && box.w >= MIN_BOX && box.h >= MIN_BOX) done(box);
      else {
        sel.hidden = true;
        hint.hidden = false;
      }
    });
  }

  /** A thin frame drawn just outside the box, so it shows where the recording is but is never in it. */
  function showFrame(box) {
    frame?.remove();
    if (!box) return;
    frame = h("div", { class: "frame" });
    Object.assign(frame.style, { left: `${box.x - 4}px`, top: `${box.y - 4}px`, width: `${box.w + 8}px`, height: `${box.h + 8}px` });
    root.append(frame);
  }

  // ------------------------------------------------------------ countdown
  function countdown(box) {
    return new Promise((resolve) => {
      const n = h("div", { class: "count-num", "aria-live": "assertive" });
      const c = h("div", { class: "count" }, n);
      count = c;
      if (box) Object.assign(c.style, { left: `${box.x + box.w / 2}px`, top: `${box.y + box.h / 2}px` });
      root.append(c);
      let i = 3;
      const step = () => {
        if (i === 0 || !c.isConnected) {
          c.remove();
          // Two frames so 3-2-1 is gone, one invisible repaint so the capture sends that clean page, then a
          // moment for it to reach the recorder (a hidden tab has no frames, so don't wait for them).
          Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 120))])
            .then(nudge)
            .then(() => new Promise((r) => setTimeout(r, 200)))
            .then(resolve);
          return;
        }
        n.textContent = String(i--);
        n.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1000, easing: "ease-out" });
        setTimeout(step, 1000);
      };
      step();
    });
  }

  // ------------------------------------------------------------ a card left from before an update
  /** This copy can't reach the extension any more: one line saying where things are, then gone. */
  function orphaned() {
    card?.remove();
    const note = h("div", { class: "card orphan", role: "status", text: "Neat Record was updated. Your video is in Downloads — click the Neat Record icon for your last recording." });
    root.append(note);
    const r = note.getBoundingClientRect();
    place(note, innerWidth - r.width - 16, innerHeight - r.height - 16);
    setTimeout(() => host.remove(), 8000);
  }

  // ------------------------------------------------------------ first frame on a still page
  // Tab capture only sends a frame when something repaints. A 1-pixel, almost transparent dot shown for
  // two frames makes the page repaint once, invisibly, so a still page is recorded from the first second.
  async function nudge() {
    const dot = h("div", { class: "nudge" });
    root.append(dot);
    const frames = (async () => {
      for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    })();
    await Promise.race([frames, new Promise((r) => setTimeout(r, 300))]); // a hidden tab draws no frames
    dot.remove();
  }

  // ------------------------------------------------------------ click highlights
  function onClick(e) {
    if (!clicksOn || !e.isTrusted || e.button !== 0 || host.contains(e.target)) return;
    const r = h("div", { class: "ripple" });
    Object.assign(r.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
    root.append(r);
    // Full strength for most of its life, so it shows up in the video (30 frames a second), then fades.
    r.animate(
      [
        { transform: "translate(-50%,-50%) scale(.4)", opacity: 1 },
        { transform: "translate(-50%,-50%) scale(1)", opacity: 1, offset: 0.65 },
        { transform: "translate(-50%,-50%) scale(1.1)", opacity: 0 },
      ],
      { duration: 900, easing: "ease-out" },
    ).finished.then(() => r.remove());
  }
  addEventListener("pointerdown", onClick, true);

  // ------------------------------------------------------------ webcam bubble (Pro)
  function showCamera(box) {
    if (camera) return;
    // "camera *": the frame's src is the per-session dynamic URL, while the page inside has the
    // extension's own origin, so a plain allow="camera" (which means "the src origin") wouldn't reach it.
    const frameEl = h("iframe", { allow: "camera *", src: chrome.runtime.getURL("camera.html"), title: "Your camera", class: "cam-frame" });
    camera = h("div", { class: "cam", role: "img", "aria-label": "Your camera" }, frameEl, h("div", { class: "cam-handle", title: "Drag to move" }));
    const size = 168;
    let x = innerWidth - size - 24;
    let y = innerHeight - size - 88;
    if (box) {
      x = Math.min(box.x + box.w - size - 16, innerWidth - size - 8);
      y = Math.min(box.y + box.h - size - 16, innerHeight - size - 8);
    }
    place(camera, x, y);
    draggable(camera, camera.querySelector(".cam-handle"));
    root.append(camera);
  }

  // ------------------------------------------------------------ floating bar
  function showBar() {
    if (bar || barless) return bar;
    const time = h("span", { class: "time", role: "timer", "aria-label": "Recording time", text: "0:00" });
    const pause = state.pro ? h("button", { class: "bar-btn", "data-act": "pause", "aria-label": "Pause", title: "Pause" }, icon("pause", { size: 18 })) : null;
    const stop = h("button", { class: "bar-btn stop", "data-act": "stop", "aria-label": "Stop and save", title: "Stop and save" }, icon("stop", { size: 18 }), h("span", { text: "Stop" }));
    const grip = h("div", { class: "grip", title: "Drag to move", "aria-hidden": "true" }, icon("grip", { size: 16 }));
    const mic = state.micBlocked ? h("span", { class: "bar-note", title: "Recording without the microphone (it's blocked)" }, icon("mic", { size: 14 }), "off") : null;
    bar = h("div", { class: "bar", role: "toolbar", "aria-label": "Recording controls" }, grip, h("span", { class: "rec-dot" }), time, mic, pause, stop);
    pause?.addEventListener("click", (e) => e.isTrusted && send({ type: state.paused ? "resume" : "pause" }));
    stop.addEventListener("click", (e) => e.isTrusted && send({ type: "stop" }));
    root.append(bar);
    const r = bar.getBoundingClientRect();
    const pos = barPosition(state.box, r.width || 210, r.height || 48);
    if (!pos) return noBar();
    place(bar, pos.x, pos.y);
    // It can be moved, but never onto the box (it would be in the video).
    draggable(bar, grip, (x, y) => !overlapsBox(x, y, bar.offsetWidth, bar.offsetHeight));
    return bar;
  }

  /** No room outside the box: no bar on the page at all; the panel's Stop stops it (it is not in a box video). */
  function noBar() {
    bar?.remove();
    bar = null;
    barless = true;
    send({ type: "bar:none" });
    return null;
  }

  /** True when a w×h rectangle at x,y would touch the recorded box (with the same 12-px gap the bar keeps). */
  function overlapsBox(x, y, w, hgt) {
    const b = state.box;
    if (!b) return false;
    const g = 12;
    return x < b.x + b.w + g && x + w > b.x - g && y < b.y + b.h + g && y + hgt > b.y - g;
  }

  /** Bottom-left by default; with a box, just below or above it, never on top of it. */
  function barPosition(box, w, hgt) {
    const m = 16;
    if (!box) return { x: m, y: innerHeight - hgt - m };
    const x = Math.max(m, Math.min(box.x, innerWidth - w - m));
    if (box.y + box.h + 12 + hgt + m <= innerHeight) return { x, y: box.y + box.h + 12 };
    if (box.y - 12 - hgt >= m) return { x, y: box.y - 12 - hgt };
    if (box.x + box.w + 12 + w + m <= innerWidth) return { x: box.x + box.w + 12, y: Math.max(m, box.y) };
    if (box.x - 12 - w >= m) return { x: box.x - 12 - w, y: Math.max(m, box.y) };
    return null; // the box fills the page: there is nowhere outside it
  }

  function updateTimer() {
    clearTimeout(tick);
    if (!bar || state.phase !== "recording") return;
    const ms = (state.bankedMs || 0) + (state.paused || !state.startedAt ? 0 : Date.now() - state.startedAt);
    // Free: the limit is in sight, quietly — "4:12 / 10:00".
    bar.querySelector(".time").textContent = state.limitMs ? `${clock(ms)} / ${clock(state.limitMs)}` : clock(ms);
    bar.classList.toggle("paused", !!state.paused);
    const p = bar.querySelector('[data-act="pause"]');
    if (p) {
      p.replaceChildren(icon(state.paused ? "play" : "pause", { size: 18 }));
      p.setAttribute("aria-label", state.paused ? "Resume" : "Pause");
    }
    if (!state.paused) tick = setTimeout(updateTimer, 1000 - (ms % 1000) + 5);
  }

  // ------------------------------------------------------------ saved card
  function showCard() {
    const last = state.last;
    const pro = (name, label, act, title) => h("button", { class: "chip", "data-act": act, title, disabled: !!state.job || state.phase !== "done" || state.unsaved }, icon(name, { size: 16 }), h("span", { text: label }));
    const title = state.phase === "saving" ? "Saving…" : state.phase === "error" ? "Something went wrong" : state.unsaved ? "Not saved yet" : "Saved to Downloads";
    const head = h(
      "div",
      { class: "card-head" },
      h("span", { class: `badge ${state.phase === "error" ? "err" : state.phase === "saving" ? "busy" : ""}` }, state.phase === "saving" ? h("span", { class: "spinner" }) : icon(state.phase === "error" ? "close" : "check", { size: 16 })),
      h("strong", { text: title }),
      state.phase === "saving" || state.job ? null : h("button", { class: "icon-btn", "data-act": "dismiss", "aria-label": "Close", title: "Close" }, icon("close", { size: 16 })),
    );
    const meta = last ? h("div", { class: "meta", text: `${last.filename} · ${clock(last.durationMs)} · ${mb(last.size)}` }) : null;
    // Free: just the file. Pro: Share, Trim, GIF too. (Locks live only in the panel.)
    const show = state.unsaved
      ? h("button", { class: "chip primary", "data-act": "save-again" }, icon("folder", { size: 16 }), h("span", { text: "Save again" }))
      : h("button", { class: "chip", "data-act": "show", "aria-label": "Show in folder" }, icon("folder", { size: 16 }), h("span", { text: "Show" }));
    // A recording saved without its index can't be shared, trimmed or made into a GIF.
    const jobs = state.pro && !(last && last.unindexed);
    const actions =
      state.phase === "done"
        ? h(
            "div",
            { class: `chips ${jobs ? "" : "one"}` },
            show,
            jobs ? pro("link", "Share", "share", "Upload to your Google Drive and copy a link anyone can watch") : null,
            jobs ? pro("scissors", "Trim", "trim", "Cut the start and end") : null,
            jobs ? pro("gif", "GIF", "gif", "A GIF of the first 30 seconds") : null,
          )
        : null;
    const job = state.job ? h("div", { class: "job" }, jobBar(state.job.fraction), h("span", { text: state.job.kind === "share" ? (state.job.stage === "signin" ? "Waiting for Google sign-in…" : "Uploading to your Google Drive…") : state.job.kind === "gif" ? "Making the GIF…" : "Trimming…" })) : null;
    const toast = state.toast ? h("div", { class: "toast", role: "status", text: state.toast }) : null;
    const link = state.link ? h("div", { class: "linkrow" }, h("input", { class: "link", readonly: true, value: state.link, "aria-label": "Share link" }), h("button", { class: "chip", "data-act": "copy", "aria-label": "Copy link" }, icon("copy", { size: 16 }), h("span", { text: "Copy" }))) : null;
    const note = state.note ? h("p", { class: "note", text: state.note }) : null;
    const gifHint = jobs && state.phase === "done" && last && last.durationMs > 30_000 ? h("p", { class: "note", text: "GIF keeps the first 30 seconds." }) : null;
    const hadFocus = card && card.contains(root.activeElement);
    card?.remove();
    card = h("div", { class: "card", role: "dialog", "aria-label": title, tabindex: "-1" }, head, meta, actions, gifHint, job, link, toast, note);
    card.addEventListener("click", (e) => {
      if (!e.isTrusted) return; // the page can't press our buttons
      if (!chrome.runtime || !chrome.runtime.id) return orphaned(); // the extension was updated or reloaded
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act === "trim") return trimPanel();
      if (act === "copy") {
        const input = card.querySelector(".link");
        input.select();
        navigator.clipboard.writeText(input.value).catch(() => document.execCommand("copy"));
        return;
      }
      send({ type: act });
    });
    root.append(card);
    const r = card.getBoundingClientRect();
    place(card, innerWidth - r.width - 16, innerHeight - r.height - 16);
    if (!hadFocus && state.phase !== "saving") card.focus({ preventScroll: true });
  }

  function jobBar(fraction) {
    const fill = h("i");
    fill.style.width = `${Math.round((fraction || 0) * 100)}%`;
    return h("div", { class: "job-bar" }, fill);
  }

  function trimPanel() {
    const total = Math.max(1, Math.floor((state.last.durationMs || 0) / 1000));
    const s = h("input", { type: "range", min: 0, max: total, step: 1, value: 0, "aria-label": "Start" });
    const e = h("input", { type: "range", min: 0, max: total, step: 1, value: total, "aria-label": "End" });
    const label = h("div", { class: "trim-label" });
    const paint = () => {
      if (Number(s.value) >= Number(e.value)) s.value = String(Math.max(0, Number(e.value) - 1));
      label.textContent = `Keep ${clock(s.value * 1000)} to ${clock(e.value * 1000)}`;
    };
    s.addEventListener("input", paint);
    e.addEventListener("input", () => {
      if (Number(e.value) <= Number(s.value)) e.value = String(Math.min(total, Number(s.value) + 1));
      paint();
    });
    paint();
    const panel = h(
      "div",
      { class: "trim" },
      h("label", {}, h("span", { text: "Start" }), s),
      h("label", {}, h("span", { text: "End" }), e),
      label,
      h(
        "div",
        { class: "row" },
        h("button", { class: "chip", text: "Cancel", onclick: () => panel.remove() }),
        h("button", { class: "chip primary", text: "Save trimmed copy", onclick: (ev) => ev.isTrusted && send({ type: "trim", startMs: Number(s.value) * 1000, endMs: Number(e.value) * 1000 }) }),
      ),
    );
    card.querySelector(".trim")?.remove();
    card.append(panel);
    const r = card.getBoundingClientRect();
    place(card, innerWidth - r.width - 16, innerHeight - r.height - 16);
    s.focus();
  }

  // ------------------------------------------------------------ render
  function render(next) {
    state = next || { phase: "idle" };
    clicksOn = state.phase === "recording" && !!state.clicks;
    if (state.phase === "recording" || state.phase === "countdown") {
      card?.remove();
      card = null;
      showFrame(state.box);
      if (state.camera && !camera) showCamera(state.box);
      // The bar only appears around a drawn box, outside it. In Tab, Window and Screen
      // recordings it would be in the video, so there the panel and Chrome's own
      // sharing controls stop the recording instead.
      if (state.phase === "recording" && state.mode === "box") {
        showBar();
        updateTimer();
      }
      return;
    }
    clearTimeout(tick);
    bar?.remove();
    bar = null;
    frame?.remove();
    frame = null;
    camera?.remove();
    camera = null;
    // While a whole-page recording is still being saved, the page is still being filmed: no card yet.
    if (["done", "error"].includes(state.phase) || (state.phase === "saving" && state.mode !== "tab")) showCard();
    else clearUi();
  }

  /** Nothing to show right now (idle, starting, choosing a box). */
  function clearUi() {
    clearTimeout(tick);
    for (const n of [bar, card, frame, camera, count]) n?.remove();
    bar = card = frame = camera = count = null;
    barless = false;
    clicksOn = false;
  }

  /** Back to nothing: remove everything we added to the page, listeners included. */
  function teardown() {
    clearUi();
    clearTimeout(resizeTimer);
    chrome.runtime.onMessage.removeListener(onMessage);
    removeEventListener("pointerdown", onClick, true);
    removeEventListener("resize", onResize);
    removeEventListener("pagehide", onGone);
    host.remove();
    globalThis[KEY] = false; // a later click injects a fresh copy
  }

  // Box recording: if the tab is resized or zoomed, the recorder re-crops the same part of the page.
  addEventListener("resize", onResize);
  function onResize() {
    if (state.phase !== "recording" || state.mode !== "box") return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      send({ type: "viewport", viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio } });
      showFrame(state.box);
      if (bar) {
        const r = bar.getBoundingClientRect();
        const pos = barPosition(state.box, r.width, r.height);
        if (pos) place(bar, pos.x, pos.y);
        else noBar();
      }
    }, 150);
  }

  // ------------------------------------------------------------ helpers
  function place(n, x, y) {
    n.style.left = `${Math.round(Math.max(8, Math.min(x, innerWidth - 8 - (n.offsetWidth || 0))))}px`;
    n.style.top = `${Math.round(Math.max(8, Math.min(y, innerHeight - 8 - (n.offsetHeight || 0))))}px`;
  }
  function draggable(n, handle, allowed = () => true) {
    let from = null;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      from = { x: e.clientX - n.offsetLeft, y: e.clientY - n.offsetTop };
    });
    handle.addEventListener("pointermove", (e) => from && allowed(e.clientX - from.x, e.clientY - from.y) && place(n, e.clientX - from.x, e.clientY - from.y));
    handle.addEventListener("pointerup", () => (from = null));
  }

  send({ type: "state" }).then((s) => s && s.phase && render(s));
}

const CSS = `
* { box-sizing: border-box; }
/* The host element is reset with all: initial (so page styles can't leak in), which also resets the
   inherited font: set it on our own top-level elements. */
:host > * { font: 14px/1.4 var(--font); color: var(--text); }
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
[hidden] { display: none !important; }

.select { position: fixed; inset: 0; cursor: crosshair; background: rgba(10, 10, 12, 0.32); touch-action: none; outline: none; }
.hint { position: fixed; left: 50%; top: 24px; transform: translateX(-50%); display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-radius: 999px; background: var(--surface); color: var(--text); box-shadow: var(--shadow-lg); font: 14px/1.2 var(--font); pointer-events: none; }
.hint span { color: var(--muted); }
.sel { position: fixed; box-shadow: 0 0 0 9999px rgba(10, 10, 12, 0.45); outline: 2px solid #fff; outline-offset: 0; background: transparent; }
.select:has(.sel:not([hidden])) { background: transparent; }
.size { position: absolute; left: 0; top: -30px; padding: 4px 8px; border-radius: var(--r-sm); background: var(--surface); color: var(--text); font: 600 12px/1.2 var(--font); font-variant-numeric: tabular-nums; box-shadow: var(--shadow); white-space: nowrap; }
.size.inside { top: 8px; left: 8px; }

.frame { position: fixed; pointer-events: none; border: 2px dashed var(--accent); border-radius: 4px; }

.bar { position: fixed; display: flex; align-items: center; gap: 4px; height: 48px; padding: 0 6px 0 4px; border-radius: 999px; background: var(--surface); color: var(--text); box-shadow: none; border: 1px solid var(--muted); user-select: none; }
.grip { display: grid; place-items: center; width: 24px; height: 40px; color: var(--muted); cursor: grab; touch-action: none; }
.grip:active { cursor: grabbing; }
.rec-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); margin: 0 4px 0 2px; animation: pulse 1.6s ease-in-out infinite; }
.bar.paused .rec-dot { animation: none; background: var(--muted); }
.time { min-width: 48px; font: 600 15px/1 var(--font); font-variant-numeric: tabular-nums; }
.bar-btn { position: relative; display: inline-flex; align-items: center; gap: 6px; height: 36px; min-width: 36px; padding: 0 9px; border: 0; border-radius: 999px; background: var(--surface-2); }
.bar-btn:hover { background: var(--surface-3); }
.bar-btn.stop { background: var(--accent); color: var(--accent-ink); padding: 0 14px 0 11px; font-weight: 600; }
.bar-btn.stop:hover { background: var(--accent-hover); }
.bar-note { display: inline-flex; align-items: center; gap: 2px; padding: 0 8px; height: 28px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 650; }
@keyframes pulse { 50% { opacity: .35; } }

.count { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 152px; height: 152px; border-radius: 50%; display: grid; place-items: center; background: rgba(17, 17, 20, 0.72); color: #fff; pointer-events: none; }
.count-num { font: 700 76px/1 var(--font); font-variant-numeric: tabular-nums; }

.card.orphan { max-width: 360px; font-size: 13px; padding: 12px 16px; }
.nudge { position: fixed; right: 0; bottom: 0; width: 1px; height: 1px; background: rgba(0, 0, 0, 0.01); pointer-events: none; }
.ripple { position: fixed; width: 56px; height: 56px; border-radius: 50%; border: 4px solid var(--accent); background: rgba(214, 54, 60, 0.28); box-shadow: 0 0 0 2px #fff, 0 2px 10px rgba(0, 0, 0, 0.35); pointer-events: none; transform: translate(-50%, -50%); }

.cam { position: fixed; width: 168px; height: 168px; border-radius: 50%; overflow: hidden; box-shadow: var(--shadow-lg); background: #000; }
.cam-frame { width: 100%; height: 100%; border: 0; display: block; }
.cam-handle { position: absolute; inset: 0; border-radius: 50%; cursor: grab; touch-action: none; }

.card { position: fixed; width: 360px; padding: 16px; border-radius: var(--r-lg); background: var(--surface); color: var(--text); box-shadow: var(--shadow-lg); border: 1px solid var(--border); display: grid; gap: 12px; }
.card-head { display: flex; align-items: center; gap: 10px; }
.card-head strong { flex: 1; font-size: 15px; }
.badge { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: #e7f6ec; color: #18794e; }
.badge.err { background: var(--accent-soft); color: var(--accent); }
.badge.busy { background: var(--surface-2); color: var(--muted); }
.spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.icon-btn { width: 32px; height: 32px; border: 0; border-radius: 50%; background: transparent; color: var(--muted); display: grid; place-items: center; }
.icon-btn:hover { background: var(--surface-2); color: var(--text); }
.meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chips { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
.chips.one { grid-template-columns: 1fr; }
.card:focus { outline: none; }
.card:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.chip { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); font-weight: 550; }
.chip:hover:not(:disabled) { background: var(--surface-3); }
.chip:disabled { opacity: .5; cursor: default; }
.chip.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.chip.primary:hover { background: var(--accent-hover); }
.job { display: grid; gap: 6px; font-size: 12px; color: var(--muted); }
.job-bar { height: 6px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.job-bar i { display: block; height: 100%; background: var(--accent); transition: width .2s; }
.linkrow { display: flex; gap: 8px; }
.link { flex: 1; min-width: 0; height: 36px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text); font: 13px var(--font); }
.toast { padding: 8px 12px; border-radius: var(--r-sm); background: var(--surface-2); font-weight: 550; }
.note { margin: 0; color: var(--muted); font-size: 12px; }
.trim { display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
.trim label { display: grid; grid-template-columns: 48px 1fr; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.trim input { accent-color: var(--accent); width: 100%; }
.trim-label { font-weight: 600; font-variant-numeric: tabular-nums; }
.row { display: flex; justify-content: flex-end; gap: 8px; }
@media (prefers-reduced-motion: reduce) { .rec-dot, .spinner { animation: none; } }
`;

// Last, so everything above (CSS included) exists. Injecting twice is harmless.
if (!globalThis[KEY]) {
  globalThis[KEY] = true;
  main();
}
