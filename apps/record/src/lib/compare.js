// Free vs Pro, the one source for the Pro page in the extension, the hosted
// pro.html poster and the store copy.
import app from "../../app.config.js";

export const FREE = [
  { icon: "tab", text: "Tab, window, screen, draw a box" },
  { icon: "mic", text: "Microphone and sound" },
  { icon: "screen", text: "Up to 1080p HD" },
  { icon: "check", text: "No watermark, no account" },
  { icon: "folder", text: "Unlimited recordings" },
  { icon: "countdown", text: `${app.freeLimitMinutes} minutes per recording` },
];
export const PRO = [
  { icon: "infinity", text: "No time limit" },
  { icon: "screen", text: "1440p and 4K" },
  { icon: "link", text: "Share link to your Google Drive" },
  { icon: "camera", text: "Webcam bubble" },
  { icon: "click", text: "Click highlights" },
  { icon: "three", text: "3-2-1 countdown" },
  { icon: "pause", text: "Pause and resume" },
  { icon: "scissors", text: "Trim start and end" },
  { icon: "gif", text: "Save as GIF (up to 30 s)" },
  { icon: "grip", text: "Keyboard shortcut" },
];
export const TERMS = "One payment, yours to keep. Use it on up to 3 of your own computers — that is the licence term; nothing checks or counts them.";
