// YouTube behaviours that are not "hide an element". Bundled code, toggled by
// the user; remote rules can never add or change these.
import { BRAND_SLUG } from "../../../brand.config.js";

const SHORTS_RE = /^\/shorts\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;
const LOOP_KEY = `${BRAND_SLUG}-redirect`;
const LOOP_WINDOW_MS = 10000;

/** "/shorts/ID" → "/watch?v=ID", or null. Exported for tests. */
export function watchUrlFor(pathname) {
  const m = SHORTS_RE.exec(pathname);
  return m ? `/watch?v=${m[1]}` : null;
}

/**
 * Loop guard: if we already redirected this same id within the window and are
 * back on its /shorts/ URL, YouTube is bouncing us — stop and let it play.
 */
function allowedToRedirect(id) {
  try {
    const now = Date.now();
    const prev = JSON.parse(sessionStorage.getItem(LOOP_KEY) || "null");
    const n = prev && prev.id === id && now - prev.t < LOOP_WINDOW_MS ? prev.n + 1 : 1;
    sessionStorage.setItem(LOOP_KEY, JSON.stringify({ id, t: now, n }));
    return n <= 2;
  } catch {
    return true;
  }
}

function redirectIfShorts(ctx) {
  // Redirect is not paused by the allow list: the watch page it lands on is, if the channel is allowed.
  if (!ctx.isOn("shorts-redirect", { respectAllowlist: false })) return;
  const target = watchUrlFor(location.pathname);
  if (!target) return;
  const id = target.slice(9);
  if (!allowedToRedirect(id)) return;
  location.replace(target);
}

export const shortsRedirect = {
  onReady: redirectIfShorts,
  onNavigate: redirectIfShorts,
  // Intercept plain left-clicks on Shorts links before YouTube's SPA opens its Shorts player.
  onClick(e, ctx) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!ctx.isOn("shorts-redirect", { respectAllowlist: false })) return;
    const a = e.target instanceof Element ? e.target.closest('a[href^="/shorts/"]') : null;
    if (!a) return;
    const target = watchUrlFor(new URL(a.href, location.href).pathname);
    if (!target) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    location.assign(target);
  },
};

let handledVideo = null;
function autoplayOff(ctx) {
  if (location.pathname !== "/watch" || !ctx.isOn("autoplay-off")) return;
  const v = new URLSearchParams(location.search).get("v");
  if (!v || v === handledVideo) return;
  const btn = document.querySelector(".ytp-autonav-toggle-button");
  if (!btn) return; // player not built yet; the next pass will try again
  handledVideo = v; // once per video, so a user who turns it back on is not overruled
  if (btn.getAttribute("aria-checked") === "true") {
    const button = btn.closest("button") || btn;
    button.click();
  }
}

export const autoplay = { onNavigate: autoplayOff, onPass: autoplayOff, onReady: autoplayOff };

export default [shortsRedirect, autoplay];
