// Webcam bubble (Pro): the page shows this extension page in a small round
// frame, so the camera is in the recording and the user sees themselves.
const v = document.getElementById("v");
const msg = document.getElementById("msg");
navigator.mediaDevices
  .getUserMedia({ video: { width: { ideal: 480 }, height: { ideal: 480 }, aspectRatio: 1, facingMode: "user" }, audio: false })
  .then((s) => {
    v.srcObject = s;
    v.play().catch(() => {});
    addEventListener("pagehide", () => s.getTracks().forEach((t) => t.stop()));
  })
  .catch((e) => {
    document.body.dataset.error = (e && e.name) || "Error";
    msg.hidden = false;
  });
