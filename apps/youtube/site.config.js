// Site config for "Neat for YouTube". A product = engine + rules.json + this file.
// Everything here is plain data or small pure helpers; no remote input reaches code.
import { BRAND, SITE_URL, OLD_SITE_URL } from "../../brand.config.js";

// Handles: letters/marks/digits in any script plus _ . - · (YouTube's allowed set), 3–100 chars.
const HANDLE_RE = /^@[\p{L}\p{M}\p{N}_.\-·]{3,100}$/u;
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

/**
 * Turn "@Name", "name", "UC…", or a youtube.com/@name or /channel/UC… URL into a
 * canonical allow-list key. Anything else (video URLs, /c/ or /user/ legacy URLs,
 * other sites) returns null so it can never be saved as the wrong channel.
 */
export function normalizeChannel(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().normalize("NFC");
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /^([a-z0-9-]+\.)?youtube\.com(\/|$)/i.test(s)) {
    let u;
    try {
      u = new URL(/^https?:/i.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return "";
      }
    });
    if (parts[0] === "channel") s = parts[1] || "";
    else if (parts[0] && parts[0].startsWith("@")) s = parts[0];
    else return null;
    s = s.normalize("NFC");
  }
  if (CHANNEL_ID_RE.test(s)) return s;
  if (s.includes("/")) return null;
  if (!s.startsWith("@")) s = `@${s}`;
  s = s.toLowerCase();
  return HANDLE_RE.test(s) ? s : null;
}

function channelFromHref(href) {
  if (!href) return null;
  const m = /^\/(@[^/?#]+)/.exec(href);
  if (m) {
    let raw = m[1];
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* keep raw */
    }
    const handle = normalizeChannel(raw);
    return handle ? { handle } : null;
  }
  const c = /^\/channel\/(UC[\w-]{22})/.exec(href);
  return c ? { id: c[1] } : null;
}

const SHORTS_LINK = 'a[href^="/shorts/"], a[href^="https://www.youtube.com/shorts/"]';

export default {
  id: "youtube",
  name: "YouTube",
  productName: `${BRAND} for YouTube`,
  listingTitle: `${BRAND} — Hide YouTube Shorts`,
  version: "1.0.1",
  matches: ["https://www.youtube.com/*"],
  hostPermissions: ["https://www.youtube.com/*"],
  // docs/youtube/ of the public repo, served at SITE_URL. Builds up to 1.0.0 fetch it from
  // OLD_SITE_URL, which keeps serving it directly; from 1.0.1 that is only the fallback, tried
  // when SITE_URL fails. Override at build time with RULES_URL=https://… (which drops the
  // fallback unless RULES_FALLBACK_URL is also set).
  rulesUrl: `${SITE_URL}youtube/rules.json`,
  rulesFallbackUrl: `${OLD_SITE_URL}youtube/rules.json`,
  // Public half of the rules-signing key (scripts/rules-key.mjs). Override with RULES_PUBLIC_KEY.
  // While null, remote rules are disabled entirely. Private half: .secrets/ (never committed).
  rulesPublicKey: { kty: "EC", crv: "P-256", x: "i4iJ16P-SZ_jd8JKoGZKHxAJThFlHYBtGe5LMofjzD8", y: "GZDTYeioOqm34v-qNeQrk7QOoBIR18ApuFOpbvC9Oaw" },
  // Chrome Web Store item id (32 letters a–p), used by npm run release:ship. Set once the item exists.
  storeItemId: "ojmhepcnbecbgcoehobgflnlfmebelkh",
  masterCommand: { id: "toggle-master", key: "Alt+Shift+Y" },
  navigationEvents: ["yt-navigate-finish", "yt-page-data-updated"],
  groups: ["Shorts", "Watch page", "Home"],

  // Behaviours that are not "hide an element". Implemented in src/features.js.
  features: [
    { id: "shorts-redirect", label: "Open Shorts as normal videos", group: "Shorts", default: true },
    { id: "autoplay-off", label: "Turn off autoplay", group: "Watch page", default: false },
  ],

  /**
   * Independent oracles for the self-check: what a user would see if a rule had
   * stopped working, written without reference to the rule's own locators. If
   * YouTube renames its markup so the locators match nothing, these still find
   * the visible Shorts and the rule is reported broken.
   */
  probes: {
    "shorts-home": [{ selector: `ytd-browse[page-subtype="home"] :is(${SHORTS_LINK})` }],
    "shorts-subscriptions": [{ selector: `ytd-browse[page-subtype="subscriptions"] :is(${SHORTS_LINK})` }],
    "shorts-search": [{ selector: `ytd-search :is(${SHORTS_LINK})` }],
    "shorts-channel": [
      { selector: `ytd-browse[page-subtype="channels"] ytd-item-section-renderer :is(${SHORTS_LINK})` },
      { selector: "yt-tab-shape, tp-yt-paper-tab", text: "Shorts" },
    ],
    "shorts-sidebar": [{ selector: "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer", text: "Shorts" }],
    "shorts-watch": [{ selector: `ytd-watch-next-secondary-results-renderer :is(${SHORTS_LINK}), ytd-watch-flexy ytd-reel-shelf-renderer` }],
    "shorts-notifications": [{ selector: `ytd-notification-renderer :is(${SHORTS_LINK})` }],
    "watch-comments": [{ selector: "ytd-watch-flexy ytd-comments#comments" }],
    "watch-sidebar": [{ selector: "ytd-watch-flexy #related" }],
    "watch-endscreen": [{ selector: ".html5-video-player .ytp-ce-element" }],
    "home-feed": [{ selector: 'ytd-browse[page-subtype="home"] ytd-rich-grid-renderer' }],
  },

  allowlist: {
    title: "Allowed channels",
    help: "Nothing is hidden on these channels' pages and videos. Enter the channel's @handle (shown under its name), or paste its youtube.com/@… link.",
    placeholder: "@channel or youtube.com/@channel",
    invalid: "Use the channel's @handle or a youtube.com/@… link. For /c/ or /user/ links, open the channel and copy the @handle shown under its name.",
  },

  normalizeChannel,

  /**
   * Which page we are on and whose channel it belongs to. Cheap: a couple of
   * querySelector calls. `pending` = a watch page whose owner hasn't caught up
   * with the URL yet after an in-app navigation (don't trust the old owner).
   */
  pageContext(doc, loc) {
    const p = loc.pathname;
    let page = "other";
    let channel = null;
    let pending = false;
    if (p === "/") page = "home";
    else if (p === "/results") page = "search";
    else if (p === "/watch") page = "watch";
    else if (p.startsWith("/shorts/")) page = "shorts";
    else if (p.startsWith("/feed/subscriptions")) page = "subscriptions";
    if (/^\/(@|channel\/|c\/|user\/)/.test(p)) {
      page = "channel";
      channel = channelFromHref(p) || {};
      // Canonical link carries the UC… id on every channel URL form (/@, /c/, /user/).
      const canon = doc.querySelector('link[rel="canonical"]');
      const m = canon && /\/channel\/(UC[\w-]{22})/.exec(canon.getAttribute("href") || "");
      if (m) channel.id = m[1];
      if (!channel.id && !channel.handle) channel = null;
    } else if (page === "watch") {
      const v = new URLSearchParams(loc.search).get("v");
      const flexy = doc.querySelector("ytd-watch-flexy");
      if (!flexy || flexy.getAttribute("video-id") !== v) pending = true;
      else {
        const a = doc.querySelector("ytd-watch-metadata #owner a[href], ytd-video-owner-renderer a[href]");
        channel = channelFromHref(a && a.getAttribute("href"));
        if (!channel) pending = true;
      }
    }
    return { page, channel, pending };
  },

  /** True when the current page belongs to an allow-listed channel (by @handle or UC… id). */
  isAllowed(settings, ctx) {
    const c = ctx.channel;
    if (!c) return false;
    const keys = new Set(settings.allowlist);
    for (const [id, handle] of Object.entries(settings.aliases || {})) {
      if (keys.has(id)) keys.add(handle);
      if (keys.has(handle)) keys.add(id);
    }
    return (c.handle && keys.has(c.handle)) || (c.id && keys.has(c.id)) || false;
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
