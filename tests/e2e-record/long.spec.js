// 30-minute recording: memory must stay flat (chunks stream to disk) and CPU
// is reported per Chromium process role. Also measures the idle extension.
// Windows only (reads process stats with Get-CimInstance). Run on purpose:
//   RECORD_LONG=1 npx playwright test --project=record-long
// Result: test-results/record-long.json
import { test, expect, launch, worker, startServer, setSettings, tabIdOf, call, waitPhase, lastDownload, unlockPro, RESULTS, EXT_DIR, ROOT } from "./helpers.js";
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bufferSource } from "../../apps/record/src/lib/bytes.js";
import { inspectMp4 } from "../../apps/record/src/lib/mp4.js";

const MINUTES = Number(process.env.RECORD_LONG_MINUTES || 30);

/** Every process of this browser (by parent tree from its user-data-dir), with its role. */
function sample(profile) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime | ConvertTo-Json -Compress`;
  const all = [JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", maxBuffer: 1 << 26 }))].flat();
  const root = all.find((p) => p.CommandLine && p.CommandLine.includes(profile) && !/--type=/.test(p.CommandLine));
  if (!root) return null;
  const ids = new Set([root.ProcessId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (!ids.has(p.ProcessId) && ids.has(p.ParentProcessId)) (ids.add(p.ProcessId), (grew = true));
  }
  const role = (c) => (!/--type=/.test(c) ? "browser" : /--extension-process/.test(c) ? "extension" : /--type=renderer/.test(c) ? "page" : /--type=gpu-process/.test(c) ? "gpu" : /--type=utility/.test(c) ? "utility" : "other");
  const out = {};
  for (const p of all.filter((x) => ids.has(x.ProcessId))) {
    const r = role(p.CommandLine || "");
    out[r] ||= { count: 0, privateMB: 0, workingSetMB: 0, cpuSec: 0 };
    out[r].count++;
    out[r].privateMB += Number(p.PrivatePageCount) / 1048576;
    out[r].workingSetMB += Number(p.WorkingSetSize) / 1048576;
    out[r].cpuSec += (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7;
  }
  return out;
}
const round = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "number" ? Math.round(v * 10) / 10 : v)));

test(`a ${MINUTES}-minute recording keeps memory flat`, async () => {
  test.setTimeout((MINUTES + 12) * 60_000);
  // A private copy of the build, so other test runs rebuilding dist-test can't touch this one.
  const ext = path.join(ROOT, ".scratch", "long-ext");
  rmSync(ext, { recursive: true, force: true });
  cpSync(EXT_DIR, ext, { recursive: true });
  const profile = mkdtempSync(path.join(os.tmpdir(), "neat-long-"));
  const server = await startServer();
  const ctx = await launch({ viewport: { width: 1920, height: 1080 }, extDir: ext, userDataDir: profile });
  const result = { minutes: MINUTES, cores: os.cpus().length, samples: [] };
  try {
    const sw = await worker(ctx);
    await unlockPro(sw); // no 10-minute limit
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.goto(`${server.base}/busy.html`);
    const tabId = await tabIdOf(sw, server.base);
    await setSettings(sw, { mode: "tab", sound: true, mic: true, quality: "better", countdown: false, camera: false, clicks: false });

    // Idle: the service worker goes to sleep after ~30 s; no recorder exists.
    await page.waitForTimeout(45_000);
    result.idle = round(sample(profile));
    result.idleOffscreen = false;

    expect((await call(sw, "start", { tabId })).ok).toBe(true);
    await waitPhase(sw, "recording");
    let prev = sample(profile);
    let prevT = Date.now();
    const t0 = Date.now();
    while (Date.now() - t0 < MINUTES * 60_000) {
      await page.waitForTimeout(60_000);
      const s = sample(profile);
      const dt = (Date.now() - prevT) / 1000;
      const cpu = {};
      for (const k of Object.keys(s)) cpu[k] = (((s[k].cpuSec - ((prev[k] && prev[k].cpuSec) || 0)) / dt) * 100).toFixed(1);
      result.samples.push(round({ minute: Math.round((Date.now() - t0) / 60_000), privateMB: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.privateMB])), cpuPercentOfOneCore: cpu }));
      prev = s;
      prevT = Date.now();
      writeFileSync(path.join(RESULTS, "record-long.json"), JSON.stringify(result, null, 2));
    }
    await call(sw, "stop");
    await waitPhase(sw, "done", 10 * 60_000);
    const d = await lastDownload(sw);
    const info = await inspectMp4(bufferSource(readFileSync(d.filename)));
    result.file = { mb: Math.round(d.fileSize / 1048576), minutes: +(info.durationMs / 60_000).toFixed(2), mbPerMin: +(d.fileSize / 1048576 / (info.durationMs / 60_000)).toFixed(1) };
    await page.waitForTimeout(5_000);
    result.afterSave = round(sample(profile));
    result.afterSaveOffscreen = await sw.evaluate(() => chrome.offscreen.hasDocument());
    writeFileSync(path.join(RESULTS, "record-long.json"), JSON.stringify(result, null, 2));

    // Flat: the extension process (recorder) grows by less than 60 MB from minute 2 to the end.
    const ext2 = result.samples[1].privateMB.extension;
    const extEnd = result.samples.at(-1).privateMB.extension;
    expect(extEnd - ext2, `extension private memory ${ext2} → ${extEnd} MB`).toBeLessThan(60);
    expect(result.file.minutes).toBeGreaterThan(MINUTES - 0.5);
    expect(result.afterSaveOffscreen).toBe(false);
  } finally {
    await ctx.close();
    await server.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
