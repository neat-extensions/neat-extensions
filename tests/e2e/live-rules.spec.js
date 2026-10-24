// The shipped build against the LIVE rules hosts (neatextensions.com, github.io as the
// fallback): it fetches the rules URL + .sig, verifies the signature with the built-in
// public key, refuses the same live file when the signature is tampered with in transit,
// and falls back to the second host when only the first one is tampered with.
// Runs on the release zip when dist/ has one (npm run release), else on dist-test.
import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { BRAND_SLUG } from "../../brand.config.js";
import site from "../../apps/youtube/site.config.js";
import { launch, extensionWorker, ROOT, EXT_DIR, RULES } from "./helpers.js";

const RULES_URL = process.env.E2E_RULES_URL || site.rulesUrl;
const RULES_URLS = process.env.E2E_RULES_URL ? [RULES_URL] : [RULES_URL, site.rulesFallbackUrl];
const ZIP = path.join(ROOT, "dist", `${BRAND_SLUG}-youtube-${site.version}.zip`);

function extensionUnderTest() {
  if (!existsSync(ZIP)) return { dir: EXT_DIR, from: "dist-test" };
  const dir = path.join(ROOT, "test-results", "release-unzipped");
  rmSync(dir, { recursive: true, force: true });
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(ZIP))))) {
    if (name.endsWith("/")) continue;
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), bytes);
  }
  return { dir, from: path.relative(ROOT, ZIP) };
}

test("shipped build fetches the live signed rules, verifies them, rejects a tampered signature, and falls back", async () => {
  const ext = extensionUnderTest();
  test.info().annotations.push({ type: "extension", description: ext.from }, { type: "rules-url", description: RULES_URL });
  const manifest = JSON.parse(readFileSync(path.join(ext.dir, "manifest.json"), "utf8"));
  expect(manifest.content_security_policy.extension_pages).toContain(`connect-src ${RULES_URLS.map((u) => new URL(u).origin).join(" ")};`);

  const context = await launch({ extDir: ext.dir });
  const extRequests = [];
  context.on("request", (r) => r.serviceWorker()?.url().startsWith("chrome-extension://") && extRequests.push(r.url()));
  try {
    const worker = await extensionWorker(context);
    const id = new URL(worker.url()).host;
    const meta = () => worker.evaluate(async () => (await chrome.storage.local.get("rulesMeta")).rulesMeta?.status || "");

    // On install the extension fetches the live file. "up-to-date" is only reachable after the
    // signature verified and the file validated (a bad signature throws before parsing).
    await expect.poll(meta, { timeout: 30_000 }).toBe(`up-to-date (${RULES.version})`);
    const live = await (await fetch(RULES_URL, { cache: "no-store" })).json();
    expect(live.version).toBe(RULES.version);

    // Same live rules file, signature swapped for one over different bytes (on every host) → refused.
    const tamper = async (route) => {
      const real = await route.fetch();
      const sig = Buffer.from(await real.text(), "base64");
      sig[10] ^= 0xff;
      await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: sig.toString("base64") });
    };
    for (const u of RULES_URLS) await context.route(`${u}.sig`, tamper);
    const opts = await context.newPage();
    await opts.goto(`chrome-extension://${id}/options.html`);
    await opts.locator("#d-refresh").click();
    await expect(opts.locator("#d-copied")).toContainText(/rejected: signature/);
    expect(await meta()).toMatch(/rejected: signature/);

    // Only the first host tampered → the fallback host verifies (when there is one).
    for (const u of RULES_URLS.slice(1)) await context.unroute(`${u}.sig`);
    if (RULES_URLS.length > 1) {
      await opts.locator("#d-refresh").click();
      await expect(opts.locator("#d-copied")).toContainText(`up-to-date (${RULES.version})`);
      expect(extRequests).toContain(`${RULES_URLS[1]}.sig`);
    }

    // Untampered again → verifies.
    await context.unroute(`${RULES_URL}.sig`);
    await opts.locator("#d-refresh").click();
    await expect(opts.locator("#d-copied")).toContainText(`up-to-date (${RULES.version})`);

    // The extension's only requests were the live rules URLs and their signatures.
    expect(new Set(extRequests)).toEqual(new Set(RULES_URLS.flatMap((u) => [u, `${u}.sig`])));
  } finally {
    await context.close();
  }
});
