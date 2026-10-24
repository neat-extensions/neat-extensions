// The Record release gate: exactly the permissions it needs, nothing else.
import { test, expect } from "@playwright/test";
import { RECORD_POLICY, checkToolManifest, scanSource, checkBundleSize } from "../../scripts/policy.mjs";

const good = () => ({
  manifest_version: 3,
  name: "x",
  version: "1.0.0",
  key: "A".repeat(392),
  permissions: [...RECORD_POLICY.permissions],
  background: { service_worker: "background.js" },
  web_accessible_resources: structuredClone(RECORD_POLICY.war),
  oauth2: { client_id: "1.apps.googleusercontent.com", scopes: ["https://www.googleapis.com/auth/drive.file"] },
  commands: {},
  content_security_policy: { extension_pages: "default-src 'none'; script-src 'self'; media-src 'self' blob:; connect-src https://www.googleapis.com; object-src 'none'" },
});

test.describe("Record release policy", () => {
  test("accepts the intended manifest", () => {
    expect(checkToolManifest(good(), RECORD_POLICY)).toEqual([]);
  });

  for (const [name, mutate, re] of [
    ["an extra permission", (m) => m.permissions.push("tabs"), /permissions outside/],
    ["desktopCapture", (m) => m.permissions.push("desktopCapture"), /permissions outside/],
    ["any host permission", (m) => (m.host_permissions = ["<all_urls>"]), /host permissions/],
    ["manifest content scripts", (m) => (m.content_scripts = [{ matches: ["<all_urls>"], js: ["c.js"] }]), /content scripts/],
    ["another web-accessible file", (m) => m.web_accessible_resources[0].resources.push("popup.html"), /web_accessible/],
    ["a static web-accessible URL", (m) => (m.web_accessible_resources[0].use_dynamic_url = false), /web_accessible/],
    ["a broader Drive scope", (m) => (m.oauth2.scopes = ["https://www.googleapis.com/auth/drive"]), /oauth2/],
    ["another network host", (m) => (m.content_security_policy.extension_pages = m.content_security_policy.extension_pages.replace("connect-src https://www.googleapis.com", "connect-src https://www.googleapis.com https://api.example.com")), /connect-src/],
    ["blob: outside media-src", (m) => (m.content_security_policy.extension_pages += "; img-src blob:"), /blob/],
    ["remote scripts", (m) => (m.content_security_policy.extension_pages = m.content_security_policy.extension_pages.replace("script-src 'self'", "script-src 'self' https://cdn.example.com")), /CSP/],
    ["a module service worker", (m) => (m.background.type = "module"), /classic service worker/],
    ["externally_connectable", (m) => (m.externally_connectable = { matches: ["https://*/*"] }), /externally/],
    ["a private-looking key", (m) => (m.key = "-----BEGIN PRIVATE KEY-----"), /key/],
  ]) {
    test(`rejects ${name}`, () => {
      const m = good();
      mutate(m);
      expect(checkToolManifest(m, RECORD_POLICY).join("\n")).toMatch(re);
    });
  }

  test("chrome.scripting only runs bundled files", () => {
    expect(scanSource('chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })', [], RECORD_POLICY)).toEqual([]);
    for (const bad of ["chrome.scripting.executeScript({ target: { tabId }, func: () => 1 })", 'chrome.scripting.insertCSS({ css: "x" })', "chrome.scripting.registerContentScripts([])", "chrome.userScripts.register([])"]) {
      expect(scanSource(bad, [], RECORD_POLICY).length, bad).toBeGreaterThan(0);
    }
  });

  test("only the expected hosts may appear in shipped code", () => {
    expect(scanSource('fetch("https://www.googleapis.com/drive/v3/files")', [], RECORD_POLICY)).toEqual([]);
    expect(scanSource('fetch("https://analytics.example.com/c")', [], RECORD_POLICY).length).toBe(1);
  });

  test("400 KB bundle limit", () => {
    expect(checkBundleSize(400 * 1024, RECORD_POLICY.maxBytes)).toEqual([]);
    expect(checkBundleSize(400 * 1024 + 1, RECORD_POLICY.maxBytes).length).toBe(1);
  });
});
