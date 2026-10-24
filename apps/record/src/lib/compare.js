// Free vs Pro, the one source for the Pro page in the extension, the hosted
// pro.html poster and the store copy.
import app from "../../app.config.js";

export const FREE = [
  { icon: "box", text: "Draw a box, Screen, Window, This page" },
  { icon: "mic", text: "Your voice and the sound" },
  { icon: "screen", text: "Sharp video, up to 1080p" },
  { icon: "check", text: "No watermark, no account" },
  { icon: "folder", text: "As many recordings as you like" },
  { icon: "countdown", text: `${app.freeLimitMinutes} minutes per recording` },
];
export const PRO = [
  { icon: "infinity", text: "No time limit" },
  { icon: "screen", text: "Even sharper: 1440p and 4K" },
  { icon: "link", text: "Share a link (saved in your Google Drive)" },
  { icon: "camera", text: "Your face in a little circle" },
  { icon: "click", text: "Shows where you click" },
  { icon: "three", text: "Counts 3-2-1 before it starts" },
  { icon: "pause", text: "Pause and carry on" },
  { icon: "scissors", text: "Cut off the start and the end" },
  { icon: "gif", text: "Make a GIF (up to 30 seconds)" },
  { icon: "grip", text: "Start and stop with a key (Alt+Shift+R)" },
];
export const TERMS = "Pay once, keep it. Use it on up to 3 of your own computers. That's the rule — nothing checks or counts them.";
