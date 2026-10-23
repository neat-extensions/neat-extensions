// The release gate itself: the build must fail on extra permissions, an
// oversized bundle, or dangerous code. Test the checks directly.
import { test, expect } from "@playwright/test";
import { checkManifest, scanSource, checkBundleSize, MAX_BUNDLE_BYTES } from "../../scripts/policy.mjs";

const good = () => ({
  manifest_version: 3,
  permissions: ["storage", "alarms"],
  host_permissions: ["https://www.youtube.com/*"],
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: ["https://www.youtube.com/*"], js: ["content.js"] }],
  content_security_policy: { extension_pages: "default-src 'none'; script-src 'self'; object-src 'none'; connect-src 'none'" },
});

test.describe("release policy", () => {
  test("accepts the intended manifest", () => {
    expect(checkManifest(good())).toEqual([]);
  });

  for (const [name, mutate, re] of [
    ["an extra permission", (m) => m.permissions.push("tabs"), /permissions outside/],
    ["scripting", (m) => m.permissions.push("scripting"), /permissions outside/],
    ["a broad host", (m) => m.host_permissions.push("<all_urls>"), /host permissions outside/],
    ["optional permissions", (m) => (m.optional_permissions = ["history"]), /optional/],
    ["content script on another site", (m) => m.content_scripts[0].matches.push("https://*/*"), /content script/],
    ["web accessible resources", (m) => (m.web_accessible_resources = [{ resources: ["x"], matches: ["<all_urls>"] }]), /web_accessible/],
    ["a persistent background page", (m) => (m.background = { scripts: ["bg.js"], persistent: true }), /service worker/],
    ["unsafe-eval in CSP", (m) => (m.content_security_policy.extension_pages = "script-src 'self' 'unsafe-eval'; object-src 'none'"), /CSP/],
    ["a remote script host in CSP", (m) => (m.content_security_policy.extension_pages = "script-src 'self' https://cdn.example.com; object-src 'none'"), /CSP/],
    ["manifest v2", (m) => (m.manifest_version = 2), /manifest_version/],
  ]) {
    test(`rejects ${name}`, () => {
      const m = good();
      mutate(m);
      expect(checkManifest(m).join("\n")).toMatch(re);
    });
  }

  test("bundle size limit", () => {
    expect(checkBundleSize(MAX_BUNDLE_BYTES)).toEqual([]);
    expect(checkBundleSize(MAX_BUNDLE_BYTES + 1).length).toBe(1);
  });

  test("source scan catches remote/dynamic code and unexpected hosts", () => {
    const url = "https://rules.example.com/r.json";
    expect(scanSource('fetch("https://rules.example.com/r.json"); location.href="https://www.youtube.com/"', url)).toEqual([]);
    for (const bad of ["eval(x)", "new Function('a')", "el.innerHTML = s", "el.insertAdjacentHTML('x', s)", "setInterval(f, 10)", "setTimeout('x()', 1)", "importScripts('x.js')", "chrome.scripting.executeScript({})", 'fetch("https://tracker.example.net/p")']) {
      expect(scanSource(bad, url).length, bad).toBeGreaterThan(0);
    }
  });
});
