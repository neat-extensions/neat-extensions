// Site config for "Neat for YouTube". A product = engine + rules.json + this file.
// Everything here is plain data or small pure helpers; no remote input reaches code.
import { BRAND, BRAND_SLUG } from "../../brand.config.js";

const HANDLE_RE = /^@[\p{L}\p{N}_.\-·]{3,100}$/u;
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

/** Turn "@Name", "name", a channel URL or a UC… id into a canonical allow-list key, or null. */
export function normalizeChannel(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;
  try {
    if (/^https?:\/\//i.test(s) || /^(www\.|m\.)?youtube\.com\//i.test(s)) {
      const u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
      if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
      const parts = u.pathname.split("/").filter(Boolean);
      s = decodeURIComponent((parts[0] === "channel" ? parts[1] : parts[0]) || "");
    }
  } catch {
    return null;
  }
  if (CHANNEL_ID_RE.test(s)) return s;
  if (!s.startsWith("@")) s = `@${s}`;
  s = s.toLowerCase();
  return HANDLE_RE.test(s) ? s : null;
}

function channelFromHref(href) {
  if (!href) return null;
  const m = /^\/(@[^/?#]+)/.exec(href);
  if (m) return { handle: normalizeChannel(decodeURIComponent(m[1])) };
  const c = /^\/channel\/(UC[\w-]{22})/.exec(href);
  return c ? { id: c[1] } : null;
}

export default {
  id: "youtube",
  name: "YouTube",
  productName: `${BRAND} for YouTube`,
  listingTitle: `${BRAND} — Hide YouTube Shorts`,
  version: "1.0.0",
  matches: ["https://www.youtube.com/*"],
  hostPermissions: ["https://www.youtube.com/*"],
  // Override at build time with RULES_URL=https://… . The placeholder host is never fetched.
  rulesUrl: `https://RULES_HOST/${BRAND_SLUG}-youtube/rules.json`,
  // Replace EXTENSION_ID once the store assigns one.
  reviewUrl: "https://chromewebstore.google.com/detail/EXTENSION_ID/reviews",
  masterCommand: { id: "toggle-master", key: "Alt+Shift+Y" },
  navigationEvents: ["yt-navigate-finish", "yt-page-data-updated"],
  groups: ["Shorts", "Watch page", "Home"],

  // Behaviours that are not "hide an element". Implemented in src/features.js.
  features: [
    { id: "shorts-redirect", label: "Open Shorts as normal videos", group: "Shorts", default: true },
    { id: "autoplay-off", label: "Turn off autoplay", group: "Watch page", default: false },
  ],

  allowlist: {
    title: "Allowed channels",
    help: "On these channels' pages and videos nothing is hidden. Use the @handle shown on the channel page.",
    placeholder: "@channel or channel URL",
  },

  normalizeChannel,

  /** Which page we are on and whose channel it belongs to. Cheap: one querySelector at most. */
  pageContext(doc, loc) {
    const p = loc.pathname;
    let page = "other";
    let channel = null;
    if (p === "/") page = "home";
    else if (p === "/results") page = "search";
    else if (p === "/watch") page = "watch";
    else if (p.startsWith("/shorts/")) page = "shorts";
    else if (p.startsWith("/feed/subscriptions")) page = "subscriptions";
    if (p.startsWith("/@") || p.startsWith("/channel/")) {
      page = "channel";
      channel = channelFromHref(p);
    } else if (page === "watch") {
      const a = doc.querySelector("ytd-watch-metadata #owner a[href], ytd-video-owner-renderer a[href]");
      channel = channelFromHref(a && a.getAttribute("href"));
    }
    return { page, channel };
  },

  /** True when the current page belongs to an allow-listed channel. */
  isAllowed(allowlist, ctx) {
    const c = ctx.channel;
    if (!c) return false;
    return allowlist.some((k) => k === c.handle || k === c.id);
  },

  /** A short build identifier for diagnostics, read from the page's own config text. */
  buildHint(doc) {
    for (const s of doc.querySelectorAll("script:not([src])")) {
      const m = /"INNERTUBE_CLIENT_VERSION":"([\d.]{4,40})"/.exec(s.textContent || "");
      if (m) return m[1];
    }
    return "unknown";
  },
};
