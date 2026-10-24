// Neat Record e2e fixtures: Chromium with the e2e build, a local test server
// (test pages + Range-capable file serving for playback/seek checks), a fake
// Google Drive, and helpers that drive the same handlers the popup uses.
//
// Two launch profiles, because Chromium's fake-UI flag breaks tab capture:
//   tab/box:        fake camera + mic, auto-accept prompts and tab capture, extension allow-listed
//   window/screen:  fake UI for getDisplayMedia (a fake "monitor" surface)
import { test as base, chromium, expect } from "@playwright/test";
import http from "node:http";
import path from "node:path";
import { createReadStream, readFileSync, statSync, mkdirSync } from "node:fs";
import app from "../../apps/record/app.config.js";
import { signLicence } from "../../scripts/licence-sign.mjs";

export const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const EXT_DIR = path.join(ROOT, "dist-test", "record");
export const ID = app.extensionId;
export const RESULTS = path.join(ROOT, "test-results");
mkdirSync(RESULTS, { recursive: true });
const FIXTURES = path.join(ROOT, "tests", "fixtures", "record");

const COMMON = ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream"];
const TAB_FLAGS = ["--auto-accept-camera-and-microphone-capture", "--auto-accept-this-tab-capture", `--allowlisted-extension-id=${ID}`];
const DISPLAY_FLAGS = ["--use-fake-ui-for-media-stream", `--allowlisted-extension-id=${ID}`];
// Windows Smart App Control blocks Playwright's unsigned Chromium; E2E_CHANNEL=msedge runs the
// same tests in Edge (signed, still honours --load-extension). Branded Chrome ignores it.
export const CHANNEL = process.env.E2E_CHANNEL || "chromium";

export async function launch({ display = false, viewport = { width: 1280, height: 720 }, deviceScaleFactor = 1, colorScheme = "light", extDir = EXT_DIR, userDataDir = "" } = {}) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: CHANNEL,
    headless: !process.env.HEADED,
    viewport,
    deviceScaleFactor,
    colorScheme,
    acceptDownloads: true,
    locale: "en-US",
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...COMMON, ...(display ? DISPLAY_FLAGS : TAB_FLAGS)],
  });
  return context;
}

export async function worker(context) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 20_000 });
  expect(new URL(sw.url()).host).toBe(ID); // the pinned ID really is the ID
  // Developer-console warnings from the extension show up in the test output.
  sw.on("console", (m) => ["warning", "error"].includes(m.type()) && console.log(`  [extension] ${m.text()}`));
  return sw;
}

// ---------------------------------------------------------------- local server
function serveFile(req, res, file, type) {
  const size = statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1, "Accept-Ranges": "bytes" });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    createReadStream(file).pipe(res);
  }
}

export async function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/file") {
      const p = u.searchParams.get("p");
      const type = p.endsWith(".mp4") ? "video/mp4" : p.endsWith(".webm") ? "video/webm" : p.endsWith(".gif") ? "image/gif" : "application/octet-stream";
      return serveFile(req, res, p, type);
    }
    const f = path.join(FIXTURES, path.basename(u.pathname) || "busy.html");
    let data;
    try {
      data = readFileSync(f);
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : "application/octet-stream" });
    res.end(data);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** A fake Google Drive on the port the e2e build points at. Records what it was sent. */
export async function startFakeDrive() {
  const seen = { auth: new Set(), bytes: 0, files: [], permissions: [] };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (status, obj, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Location, Range", ...headers });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, PUT", "Access-Control-Allow-Headers": "Authorization, Content-Type, Content-Range, X-Upload-Content-Type, X-Upload-Content-Length", "Access-Control-Expose-Headers": "Location, Range" });
      return res.end();
    }
    if (u.pathname.startsWith("/session/")) {
      seen.bytes += body.length;
      const [, , end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(req.headers["content-range"] || "") || [];
      if (end && Number(end) + 1 < Number(total)) return json(308, undefined, { Range: `bytes=0-${end}` });
      return json(200, { id: "file1" });
    }
    seen.auth.add(req.headers.authorization);
    if (req.headers.authorization !== "Bearer test-token") return json(401, { error: "bad token" });
    if (req.method === "GET" && u.pathname === "/drive/v3/files") return json(200, { files: [] });
    if (req.method === "POST" && u.pathname === "/drive/v3/files") return json(200, { id: "folder1" });
    if (req.method === "POST" && u.pathname === "/upload/drive/v3/files") {
      seen.files.push(JSON.parse(body.toString()));
      return json(200, {}, { Location: `http://127.0.0.1:47123/session/1` });
    }
    if (req.method === "POST" && u.pathname.endsWith("/permissions")) {
      seen.permissions.push(JSON.parse(body.toString()));
      return json(200, { id: "p" });
    }
    if (req.method === "GET" && u.pathname === "/drive/v3/files/file1") return json(200, { webViewLink: "https://drive.google.com/file/d/file1/view?usp=drivesdk" });
    return json(404, {});
  });
  await new Promise((r) => server.listen(47123, "127.0.0.1", r));
  return { seen, close: () => new Promise((r) => server.close(r)) };
}

// ---------------------------------------------------------------- driving the extension
export async function setSettings(sw, patch) {
  await sw.evaluate(async (patch) => {
    const { settings = {} } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }, patch);
}

export async function tabIdOf(sw, urlPrefix) {
  return sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url && t.url.startsWith(u)).id, urlPrefix);
}

export const call = (sw, type, msg = {}) => sw.evaluate(([type, msg]) => self.neatTest.handlers[type](msg, { id: chrome.runtime.id, tab: msg.__tab ? { id: msg.__tab } : undefined }), [type, msg]);
export const state = (sw) => sw.evaluate(() => self.neatTest.getState());

export async function waitPhase(sw, phases, timeout = 60_000) {
  const want = [phases].flat();
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < timeout) {
    st = await state(sw);
    if (want.includes(st.phase)) return st;
    if (st.phase === "error" && !want.includes("error")) throw new Error(`recording error: ${st.toast}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${want.join("/")} (last: ${JSON.stringify(st)})`);
}

/** The newest completed download, with its file on disk. */
export async function lastDownload(sw) {
  const [d] = await sw.evaluate(() => chrome.downloads.search({ orderBy: ["-startTime"], limit: 1, state: "complete" }));
  return d;
}

/**
 * Load a saved file in a real <video>: duration known and finite, a seek lands,
 * and a frame decodes there. Served over HTTP with Range, like a player reading a file.
 */
export async function probe(page, server, file) {
  await page.goto(`${server.base}/player.html`);
  return page.evaluate(async (src) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    document.body.append(v);
    await new Promise((res, rej) => {
      v.onloadedmetadata = res;
      v.onerror = () => rej(new Error(`video error ${v.error && v.error.code}`));
    });
    const duration = v.duration;
    const target = Math.min(duration * 0.6, duration - 0.5);
    const t0 = performance.now();
    await new Promise((res) => {
      v.onseeked = res;
      v.currentTime = target;
    });
    const seekMs = performance.now() - t0;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const g = c.getContext("2d");
    g.drawImage(v, 0, 0);
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)];
    return { duration, seekedTo: v.currentTime, target, seekMs, width: v.videoWidth, height: v.videoHeight, px: { tl: px(1, 1), centre: px(Math.floor(c.width / 2), Math.floor(c.height / 2)), inner: px(8, 8) } };
  }, `${server.base}/file?p=${encodeURIComponent(file)}`);
}

export async function testLicence(product = app.licenceProduct) {
  const jwk = JSON.parse(readFileSync(path.join(ROOT, "dist-test", "record-licence-test.jwk"), "utf8"));
  return signLicence(jwk, { product });
}

export async function unlockPro(sw) {
  const key = await testLicence();
  await sw.evaluate((k) => chrome.storage.sync.set({ licence: k }), key);
  return key;
}

/** One recording, start to saved file. */
export async function recordFor(sw, { tabId, ms, settings }) {
  if (settings) await setSettings(sw, settings);
  const r = await call(sw, "start", { tabId });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  await waitPhase(sw, "recording", 30_000);
  await new Promise((res) => setTimeout(res, ms));
  await call(sw, "stop");
  const st = await waitPhase(sw, "done", 60_000);
  return { st, download: await lastDownload(sw) };
}

export const test = base.extend({});
export { expect };
