// Store listing copy for Neat for YouTube. Used by the build (manifest
// description) and by scripts/store.mjs (store/ kit). Keep it truthful.
import { BRAND } from "../../brand.config.js";
import { TRUST_LINES } from "../../packages/engine/src/trust.js";

export const title = `${BRAND} — Hide YouTube Shorts`;

// Chrome Web Store summary and manifest description: max 132 characters.
export const summary = "Hide YouTube Shorts everywhere — Home, search, subscriptions, channels, sidebar — and open Shorts links as normal videos.";

export const firstLine = "Shorts gone. YouTube back to videos.";

export const benefits = [
  "Removes the Shorts shelf from Home, Subscriptions and search results.",
  "Hides the Shorts tab and Shorts shelves on channel pages, and Shorts in the sidebar menu and notifications.",
  "Opens any /shorts/ link as a normal video page, with a normal player and controls.",
  "Optional: hide comments, end-screen suggestions, the recommended sidebar or the whole Home feed, and turn off autoplay.",
  "One master switch and a keyboard shortcut (Alt+Shift+Y) to turn everything off and on.",
  "Allow list: keep everything visible on the channels you choose.",
  "Changes apply instantly — no page reload.",
  "Light and dark mode. Tiny, fast, and idle when the page is idle.",
];

export const disclosure =
  `How it works: ${BRAND} hides page elements with a style sheet inside your browser. Your settings never leave your device. To keep working when YouTube changes its layout, it downloads a signed list of hiding rules (a small JSON file of CSS selectors) — normally once a day, and never more than once an hour. That download carries no information about you, and the rules can only hide things: they cannot run code.`;

// Public source repository. Owner step: set this once the repo exists (README).
export const sourceUrl = null;

export const description = [firstLine, "", ...benefits.map((b) => `• ${b}`), "", ...TRUST_LINES, "", disclosure, "", `${BRAND} is not affiliated with or endorsed by YouTube or Google.`].join("\n");

export const category = "Productivity";
export const language = "English";
