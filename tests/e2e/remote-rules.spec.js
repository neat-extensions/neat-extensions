// Remote rules, end to end: a build pointed at a local HTTPS rules host picks up
// a newer valid rules file without a store update, rejects an invalid one and
// keeps the last good rules, and makes no request other than the rules URL.
import { test as base, expect } from "@playwright/test";
import { createServer } from "node:https";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, extensionWorker, openYouTube, countVisible, RULES, ROOT, URLS } from "./helpers.js";

const PORT = 8443;
const RULES_PATH = "/neat-youtube/rules.json";
const RULES_URL = `https://localhost:${PORT}${RULES_PATH}`;
const EXT_DIR = path.join(ROOT, "dist-test-remote", "youtube");

const test = base;
let server;
let body = "";
const served = [];

test.beforeAll(() => {
  const hasOpenssl = spawnSync("openssl", ["version"], { shell: process.platform === "win32" }).status === 0;
  test.skip(!hasOpenssl, "openssl is needed to make a throwaway TLS certificate");
  const dir = mkdtempSync(path.join(tmpdir(), "neat-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore", shell: process.platform === "win32" });
  server = createServer({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
    served.push(req.url);
    if (req.url !== RULES_PATH) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(body);
  }).listen(PORT);
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), "--skip-tests", "--out", "dist-test-remote"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, RULES_URL } });
});
test.afterAll(() => server && server.close());

const newer = () => {
  const d = structuredClone(RULES);
  d.version = "1.1.0";
  d.rules.push({ id: "remote-test", label: "Remote test: hide the YouTube logo", default: true, group: "Test", locators: [{ type: "css", selector: "ytd-masthead ytd-topbar-logo-renderer" }] });
  return d;
};

test("a newer remote rules file is applied without a store update; a bad one is rejected and the last good rules kept", async () => {
  body = JSON.stringify(newer());
  const context = await launch({ extDir: EXT_DIR, extraArgs: ["--ignore-certificate-errors"] });
  const extRequests = [];
  context.on("request", (r) => r.serviceWorker()?.url().startsWith("chrome-extension://") && extRequests.push(r.url()));
  try {
    const worker = await extensionWorker(context);
    const id = new URL(worker.url()).host;
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.local.get("rules")).rules?.version), { timeout: 20_000 }).toBe("1.1.0");

    // The new rule takes effect on the page and appears as a toggle — no reinstall.
    const page = context.pages()[0] || (await context.newPage());
    await openYouTube(page, URLS.home, "home", { scroll: false });
    expect(await countVisible(page, "ytd-masthead ytd-topbar-logo-renderer")).toBe(0);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await expect(popup.locator('input[data-id="remote-test"]')).toBeChecked();

    // Now serve something that fails strict validation (extra key + code-like text).
    const bad = newer();
    bad.version = "2.0.0";
    bad.rules[0].onload = "alert(1)";
    body = JSON.stringify(bad);
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${id}/options.html`);
    await opts.locator("#d-refresh").click();
    await expect(opts.locator("#d-copied")).toContainText(/No update \(rejected/);
    expect(await worker.evaluate(async () => (await chrome.storage.local.get("rules")).rules.version)).toBe("1.1.0");
    await expect(opts.locator("#d-status")).toContainText("rejected");

    // The only thing the extension ever requested was the rules URL.
    expect(new Set(served)).toEqual(new Set([RULES_PATH]));
    expect(extRequests.length).toBeGreaterThan(0);
    for (const u of extRequests) expect(u).toBe(RULES_URL);
  } finally {
    await context.close();
  }
});
