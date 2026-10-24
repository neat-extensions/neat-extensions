// Store listing copy for Neat Record. Used by the build (manifest name and
// description) and by scripts/store-record.mjs. Written around the phrases
// people actually search (finder/report-2026-10-23.md): "screen recorder",
// "record part of screen", "screen recorder no watermark", "record screen select area".
import { BRAND, SITE_URL } from "../../brand.config.js";
import { FREE, PRO, TERMS } from "./src/lib/compare.js";
import app from "./app.config.js";

export const title = `${BRAND} Record — Screen Recorder, Draw a Box`;

// Chrome Web Store summary and manifest description: max 132 characters.
export const summary = "Screen recorder: draw a box, or record your screen, a window or this page. No watermark, no account. Saved on your computer.";

export const firstLine = "Draw a box. Press Record. Your video is in Downloads.";

export const trustLines = ["No account.", "No watermark.", "Your video stays on your computer unless you press Share.", "Open source."];

export const benefits = [
  "Draw a box: drag a box over part of a web page and only that goes in the video — pixel-sharp, even on high-DPI screens.",
  "Or record your whole Screen, one Window (say, Excel), or This page — the web page you're on.",
  "Screen recorder with no watermark and no sign-up. One click to start.",
  "Your voice, plus the page's sound (or the computer's sound when you record the whole screen on Windows and ChromeOS).",
  "Saves straight to your Downloads folder as MP4 (or WebM where Chrome can't make MP4), with the right length and smooth seeking in common players.",
  "Three quality levels in plain words: Good (720p), Better (1080p HD), Best (1440p / 4K, Pro).",
  `Free forever: unlimited recordings, up to ${app.freeLimitMinutes} minutes each. At ${app.freeLimitMinutes}:00 it stops cleanly and saves — nothing is lost.`,
  "Light: does nothing at all until you press Record.",
];

export const proLine = `Pro (${app.price} once, no subscription): ${PRO.map((p) => p.text).join(" · ")}.`;

export const disclosure = `How it works: ${BRAND} Record captures what you choose with Chrome's own screen-capture tools and encodes the video on your computer. Nothing is uploaded unless you press Share (Pro), which uploads that one video to your own Google Drive and gives you a link anyone can watch. ${BRAND} Record can only see files it created in your Drive, never anything else.`;

export const sourceUrl = "https://github.com/neat-extensions/neat-extensions";
export const siteUrl = `${SITE_URL}record/help.html`;
export const privacyPolicyUrl = `${SITE_URL}record/privacy.html`;

export const description = [
  firstLine,
  "",
  ...benefits.map((b) => `• ${b}`),
  "",
  proLine,
  TERMS,
  "",
  ...trustLines,
  "",
  disclosure,
  "",
  `Free: ${FREE.map((f) => f.text).join(" · ")}.`,
  "",
  `${BRAND} is not affiliated with or endorsed by Google.`,
].join("\n");

export const category = "Productivity";
export const language = "English";
