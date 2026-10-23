// YouTube behaviours that are not "hide an element". Bundled code, toggled by
// the user; remote rules can never add or change these.

const SHORTS_RE = /^\/shorts\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;

/** "/shorts/ID" → "/watch?v=ID", or null. Exported for tests. */
export function watchUrlFor(pathname) {
  const m = SHORTS_RE.exec(pathname);
  return m ? `/watch?v=${m[1]}` : null;
}

let redirecting = null; // the id being redirected right now (two nav events fire per navigation)

/**
 * Fallback for Shorts pages reached without a click we could intercept (typed
 * URL, external link, back button). The service worker keeps a per-tab loop
 * guard: if YouTube keeps bouncing the same id back to /shorts/, we stop.
 */
async function redirectIfShorts(ctx) {
  // Not paused by the allow list: the watch page it lands on is, if the channel is allowed.
  if (!ctx.isOn("shorts-redirect", { respectAllowlist: false })) return;
  const target = watchUrlFor(location.pathname);
  if (!target) return;
  const id = target.slice(9);
  if (redirecting === id) return;
  redirecting = id;
  for (const v of document.querySelectorAll("video")) v.pause(); // no audio blip from the Shorts player
  const res = await ctx.send({ type: "redirect:guard", id });
  if (res && res.allow === false) {
    redirecting = null;
    return;
  }
  if (watchUrlFor(location.pathname) === target) location.replace(target);
  else redirecting = null;
}

export const shortsRedirect = {
  onReady: redirectIfShorts,
  onNavigate: redirectIfShorts,
  // Intercept plain left-clicks / Enter on Shorts links before YouTube's SPA opens its Shorts player.
  // Middle-click and modifier-clicks open a new tab, where the fallback redirect runs.
  onClick(e, ctx) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!ctx.isOn("shorts-redirect", { respectAllowlist: false })) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    let url;
    try {
      url = new URL(a.href, location.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin) return;
    const target = watchUrlFor(url.pathname);
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.assign(target);
  },
};

// The toggle exists before the player wires up its click handler, so a click can
// be ignored. Retry on later passes (spaced, capped) until it reads "off"; then
// leave it alone for this video so a user who turns it back on is not overruled.
const AUTOPLAY_MAX_TRIES = 8;
const AUTOPLAY_GAP_MS = 750;
let autoplayState = { video: null, done: false, tries: 0, last: 0 };
function autoplayOff(ctx) {
  if (location.pathname !== "/watch" || !ctx.isOn("autoplay-off")) return;
  const v = new URLSearchParams(location.search).get("v");
  if (!v) return;
  if (autoplayState.video !== v) autoplayState = { video: v, done: false, tries: 0, last: 0 };
  const s = autoplayState;
  if (s.done || s.tries >= AUTOPLAY_MAX_TRIES) return;
  const btn = document.querySelector(".ytp-autonav-toggle-button");
  if (!btn) return; // player not built yet; the next pass will try again
  if (btn.getAttribute("aria-checked") !== "true") {
    s.done = true;
    return;
  }
  const now = performance.now();
  if (now - s.last < AUTOPLAY_GAP_MS) return;
  s.last = now;
  s.tries++;
  (btn.closest("button") || btn).click();
  if (btn.getAttribute("aria-checked") !== "true") s.done = true;
}

export const autoplay = { onNavigate: autoplayOff, onPass: autoplayOff, onReady: autoplayOff };

export default [shortsRedirect, autoplay];
