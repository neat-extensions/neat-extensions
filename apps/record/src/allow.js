// One-time microphone / camera permission. The popup can't show Chrome's
// prompt, so it opens this page; once allowed, recordings can use them.
import app from "../app.config.js";

const want = new URLSearchParams(location.search).get("want")?.split(",") || ["mic"];
const mic = want.includes("mic");
const cam = want.includes("camera");
const $ = (id) => document.getElementById(id);
$("title").textContent = mic && cam ? `Let ${app.productName} use your microphone and camera` : cam ? `Let ${app.productName} use your camera` : `Let ${app.productName} use your microphone`;
$("go").addEventListener("click", async () => {
  $("go").disabled = true;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: mic, video: cam });
    s.getTracks().forEach((t) => t.stop());
    $("status").textContent = `All set. Click the ${app.productName} icon and press Record.`;
    $("go").textContent = "Done";
    setTimeout(() => window.close(), 2500);
  } catch (e) {
    $("go").disabled = false;
    const thing = mic && cam ? "microphone or camera" : cam ? "camera" : "microphone";
    $("status").textContent =
      e && e.name === "NotFoundError"
        ? `No ${thing} found. Plug one in and press Allow again — or turn it off in the panel.`
        : e && e.name === "NotReadableError"
          ? `Another app is using the ${thing}. Close it and press Allow again.`
          : `Your browser blocked it. Click the icon at the right of the address bar, choose Allow, then press Allow here again — or turn the ${thing} off in the panel.`;
  }
});
