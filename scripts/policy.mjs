// Release policy: what a built extension is allowed to contain. Used by the
// build (which fails on any error) and unit-tested on its own. Each product
// kind has an explicit profile; nothing outside its profile can ship.

export const ALLOWED_PERMISSIONS = ["storage", "alarms"];
export const ALLOWED_HOSTS = ["https://www.youtube.com/*"];
export const MAX_BUNDLE_BYTES = 300 * 1024;

const KNOWN_KEYS = new Set(["manifest_version", "name", "short_name", "version", "description", "minimum_chrome_version", "icons", "action", "options_ui", "background", "content_scripts", "permissions", "host_permissions", "commands", "content_security_policy"]);

const FORBIDDEN_SOURCE = [
  [/\beval\s*\(/, "eval("],
  [/\bFunction\s*\(/, "Function("],
  [/createElement\(\s*["'`]script/i, "script element creation"],
  [/setAttribute\(\s*["'`]on[a-z]/i, "inline event handler attribute"],
  [/\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/, "an HTML injection sink"],
  [/setTimeout\s*\(\s*["'`]/, "a string timer"],
  [/\bsetInterval\s*\(/, "setInterval (polling)"],
  [/\bimport\s*\(\s*["'`]?https?:/, "a remote import"],
  [/\bimportScripts\s*\(/, "importScripts"],
];
const NO_INJECTION = [/\bchrome\.scripting\b|\bchrome\.userScripts\b/, "a code-injection API"];

/**
 * Neat Record (a tool product): records what the user picks, saves to Downloads,
 * optional Share to the user's own Drive. No host permissions, no content
 * scripts in the manifest (the in-page UI is injected on click, from a bundled
 * file), one web-accessible page (the webcam bubble).
 */
export const RECORD_POLICY = {
  name: "record",
  permissions: ["activeTab", "downloads", "identity", "offscreen", "scripting", "storage", "tabCapture"],
  hosts: [],
  maxBytes: 400 * 1024,
  keys: new Set([...KNOWN_KEYS, "key", "oauth2", "web_accessible_resources"]),
  war: [{ resources: ["camera.html"], matches: ["<all_urls>"], use_dynamic_url: true }],
  oauthScopes: ["https://www.googleapis.com/auth/drive.file"],
  connect: ["https://www.googleapis.com"],
  frameable: ["camera.html"],
  allowedUrlHosts: ["www.googleapis.com", "neat-extensions.github.io", "buy.stripe.com", "chromewebstore.google.com", "www.w3.org"],
  // chrome.scripting only as executeScript({ files }) of our own bundled file — never func/code/CSS strings.
  scripting: "files-only",
};

/** @returns {string[]} problems with a built manifest; empty means OK. */
export function checkManifest(m, policy = null) {
  if (policy) return checkToolManifest(m, policy);
  const errors = [];
  for (const k of Object.keys(m)) if (!KNOWN_KEYS.has(k)) errors.push(`unexpected manifest key: ${k}`);
  if (m.manifest_version !== 3) errors.push("manifest_version must be 3");
  const extra = (m.permissions || []).filter((p) => !ALLOWED_PERMISSIONS.includes(p));
  if (extra.length) errors.push(`permissions outside the allowed set: ${extra.join(", ")}`);
  const missing = ALLOWED_PERMISSIONS.filter((p) => !(m.permissions || []).includes(p));
  if (missing.length) errors.push(`required permissions missing: ${missing.join(", ")}`);
  if ((m.optional_permissions || []).length || (m.optional_host_permissions || []).length) errors.push("optional permissions are not allowed");
  const hosts = (m.host_permissions || []).filter((h) => !ALLOWED_HOSTS.includes(h));
  if (hosts.length) errors.push(`host permissions outside the allowed set: ${hosts.join(", ")}`);
  for (const cs of m.content_scripts || []) {
    if ((cs.matches || []).some((x) => !ALLOWED_HOSTS.includes(x))) errors.push("content script matches outside the allowed host");
    if (cs.world && cs.world !== "ISOLATED") errors.push("content scripts must run in the isolated world");
    if (cs.css || cs.match_origin_as_fallback || cs.match_about_blank || cs.all_frames) errors.push("content scripts: no css injection, frames or origin fallbacks");
  }
  if (m.web_accessible_resources) errors.push("web_accessible_resources are not allowed");
  if (m.externally_connectable) errors.push("externally_connectable is not allowed");
  if (m.background && (m.background.scripts || m.background.page || m.background.persistent)) errors.push("background must be a service worker");
  errors.push(...checkCsp(m));
  return errors;
}

function checkCsp(m, { allowMediaBlob = false } = {}) {
  const errors = [];
  let csp = (m.content_security_policy && m.content_security_policy.extension_pages) || "";
  if (!/script-src 'self'(;|$)/.test(csp)) errors.push("CSP must be script-src 'self' only");
  if (/unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:\/\/[^ ;]*\*/.test(csp)) errors.push("CSP must not allow eval, inline or wildcard hosts");
  // The recorder plays its own saved file from a blob: URL to make GIFs; that one directive may say blob:.
  if (allowMediaBlob) csp = csp.replace(/media-src 'self' blob:/, "media-src 'self'");
  if (/(^|[\s;])(\*|https?:|data:|blob:)(?=[\s;]|$)/.test(csp)) errors.push("CSP must not allow bare *, scheme-wide or data:/blob: sources");
  if (m.content_security_policy && m.content_security_policy.sandbox) errors.push("sandbox pages are not allowed");
  if (!/object-src 'none'/.test(csp)) errors.push("CSP must set object-src 'none'");
  return errors;
}

/**
 * @param {object} m built manifest
 * @param {object} p policy profile (e.g. RECORD_POLICY)
 * @param {{testConnect?: string[]}} opts origins a test build may add to connect-src
 */
export function checkToolManifest(m, p, { testConnect = [] } = {}) {
  const errors = [];
  for (const k of Object.keys(m)) if (!p.keys.has(k)) errors.push(`unexpected manifest key: ${k}`);
  if (m.manifest_version !== 3) errors.push("manifest_version must be 3");
  const perms = m.permissions || [];
  const extra = perms.filter((x) => !p.permissions.includes(x));
  if (extra.length) errors.push(`permissions outside the allowed set: ${extra.join(", ")}`);
  const missing = p.permissions.filter((x) => !perms.includes(x));
  if (missing.length) errors.push(`required permissions missing: ${missing.join(", ")}`);
  if ((m.optional_permissions || []).length || (m.optional_host_permissions || []).length) errors.push("optional permissions are not allowed");
  if ((m.host_permissions || []).some((h) => !p.hosts.includes(h))) errors.push(`host permissions outside the allowed set: ${m.host_permissions.join(", ")}`);
  if (m.content_scripts) errors.push("no manifest content scripts: the page UI is injected only when the user clicks");
  if (JSON.stringify(m.web_accessible_resources || []) !== JSON.stringify(p.war)) errors.push("web_accessible_resources must be exactly the webcam page with a dynamic URL");
  if (m.externally_connectable) errors.push("externally_connectable is not allowed");
  if (!m.background || !m.background.service_worker || m.background.scripts || m.background.page || m.background.persistent || m.background.type) errors.push("background must be a classic service worker");
  if (m.oauth2 && (JSON.stringify(m.oauth2.scopes) !== JSON.stringify(p.oauthScopes) || Object.keys(m.oauth2).some((k) => !["client_id", "scopes"].includes(k)))) errors.push(`oauth2 may only ask for ${p.oauthScopes.join(", ")}`);
  if (m.key !== undefined && !/^[A-Za-z0-9+/=]{300,500}$/.test(m.key)) errors.push("key must be a public RSA key (base64 SPKI)");
  errors.push(...checkCsp(m, { allowMediaBlob: true }));
  const csp = (m.content_security_policy && m.content_security_policy.extension_pages) || "";
  const connect = ((/connect-src ([^;]*)/.exec(csp) || [])[1] || "").trim().split(/\s+/).filter(Boolean);
  const allowedConnect = new Set([...p.connect, ...testConnect]);
  if (connect.some((c) => !allowedConnect.has(c))) errors.push(`connect-src outside ${[...allowedConnect].join(" ")}: ${connect.join(" ")}`);
  if (!/default-src 'none'/.test(csp)) errors.push("CSP must start from default-src 'none'");
  return errors;
}

/**
 * @param {string} src     shipped JavaScript
 * @param {string|string[]} rulesUrls the rules URL(s) the bundle may mention (the one in use + the site default it overrides)
 * @param {object} [policy] a tool profile; default is the rules-product policy
 * @returns {string[]}
 */
export function scanSource(src, rulesUrls, policy = null) {
  const errors = [];
  for (const [re, what] of FORBIDDEN_SOURCE) {
    const m = re.exec(src);
    if (m) errors.push(`contains ${what}: ${m[0]}`);
  }
  if (policy && policy.scripting === "files-only") {
    for (const m of src.matchAll(/chrome\.scripting\.(\w+)\s*\(\s*(\{[^)]*)/g)) {
      if (m[1] !== "executeScript" || !/\bfiles\s*:/.test(m[2]) || /\b(func|code|css|args)\s*:/.test(m[2])) errors.push(`chrome.scripting may only run bundled files: ${m[0].slice(0, 80)}`);
    }
    if (/\bchrome\.userScripts\b/.test(src)) errors.push("contains chrome.userScripts");
    if (/\bchrome\.scripting\.(insertCSS|registerContentScripts|updateContentScripts)\b/.test(src)) errors.push("contains a chrome.scripting registration/CSS API");
  } else {
    const m = NO_INJECTION[0].exec(src);
    if (m) errors.push(`contains ${NO_INJECTION[1]}: ${m[0]}`);
  }
  const allowed = new Set(policy ? policy.allowedUrlHosts : ["www.youtube.com", "chromewebstore.google.com", "rules_host"]);
  for (const u of [rulesUrls].flat().filter(Boolean)) {
    try {
      allowed.add(new URL(u).hostname.toLowerCase());
    } catch {
      /* validated elsewhere */
    }
  }
  for (const m of src.matchAll(/https?:\/\/([a-z0-9._-]+)/gi)) {
    const host = m[1].toLowerCase();
    if (!allowed.has(host)) errors.push(`mentions unexpected URL host: ${host}`);
  }
  return errors;
}

export function checkBundleSize(bytes, max = MAX_BUNDLE_BYTES) {
  return bytes > max ? [`bundle is ${bytes} bytes, over the ${max}-byte limit`] : [];
}
