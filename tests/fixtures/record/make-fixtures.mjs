// Regenerates the raw MediaRecorder samples used by the container unit tests:
// real Chromium output (live WebM, fragmented MP4), 3 seconds, 320×180, with audio.
//   node tests/fixtures/record/make-fixtures.mjs
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";

const OUT = import.meta.dirname;
const browser = await chromium.launch({ channel: "chromium", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.goto("about:blank");
for (const [type, name] of [
  ["video/mp4;codecs=avc1.640028,mp4a.40.2", "raw.mp4"],
  ["video/webm;codecs=vp9,opus", "raw.webm"],
]) {
  const b64 = await page.evaluate(async (type) => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 180;
    const g = c.getContext("2d");
    let f = 0;
    const draw = () => {
      g.fillStyle = `hsl(${(f * 7) % 360},70%,50%)`;
      g.fillRect(0, 0, 320, 180);
      g.fillStyle = "#fff";
      g.font = "48px sans-serif";
      g.fillText(String(f++), 20, 110);
      requestAnimationFrame(draw);
    };
    draw();
    const s = c.captureStream(30);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    s.addTrack(dest.stream.getAudioTracks()[0]);
    const r = new MediaRecorder(s, { mimeType: type, videoBitsPerSecond: 400_000, videoKeyFrameIntervalDuration: 1000 });
    const ch = [];
    r.ondataavailable = (e) => ch.push(e.data);
    r.start(1000);
    await new Promise((res) => setTimeout(res, 3200));
    r.stop();
    await new Promise((res) => (r.onstop = res));
    const buf = new Uint8Array(await new Blob(ch).arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }, type);
  writeFileSync(path.join(OUT, name), Buffer.from(b64, "base64"));
  console.log(`wrote ${name} (${Buffer.from(b64, "base64").length} bytes)`);
}
await browser.close();
