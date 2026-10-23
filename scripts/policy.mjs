// Release policy: what a built extension is allowed to contain. Used by the
// build (which fails on any error) and unit-tested on its own.

export const ALLOWED_PERMISSIONS = ["storage", "alarms"];
export const ALLOWED_HOSTS = ["https://www.youtube.com/*"];
export const MAX_BUNDLE_BYTES = 300 * 1024;

const KNOWN_KEYS = new Set(["manifest_version", "name", "short_name", "version", "description", "minimum_chrome_version", "icons", "action", "options_ui", "background", "content_scripts", "permissions", "host_permissions", "commands", "content_security_policy"]);

/** @returns {string[]} problems with a built manifest; empty means OK. */
export function checkManifest(m) {
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
  const csp = (m.content_security_policy && m.content_security_policy.extension_pages) || "";
  if (!/script-src 'self'(;|$)/.test(csp)) errors.push("CSP must be script-src 'self' only");
  if (/unsafe-eval|unsafe-inline|wasm-unsafe-eval|https?:\/\/[^ ;]*\*/.test(csp)) errors.push("CSP must not allow eval, inline or wildcard hosts");
  if (/(^|[\s;])(\*|https?:|data:|blob:)(?=[\s;]|$)/.test(csp)) errors.push("CSP must not allow bare *, scheme-wide or data:/blob: sources");
  if (m.content_security_policy && m.content_security_policy.sandbox) errors.push("sandbox pages are not allowed");
  if (!/object-src 'none'/.test(csp)) errors.push("CSP must set object-src 'none'");
  return errors;
}

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
  [/\bchrome\.scripting\b|\bchrome\.userScripts\b/, "a code-injection API"],
];
const ALLOWED_URL_HOSTS = ["www.youtube.com", "chromewebstore.google.com", "rules_host"];

/**
 * @param {string} src     shipped JavaScript
 * @param {string} rulesUrl the one remote URL the bundle may mention
 * @returns {string[]}
 */
export function scanSource(src, rulesUrl) {
  const errors = [];
  for (const [re, what] of FORBIDDEN_SOURCE) {
    const m = re.exec(src);
    if (m) errors.push(`contains ${what}: ${m[0]}`);
  }
  const allowed = new Set(ALLOWED_URL_HOSTS);
  try {
    allowed.add(new URL(rulesUrl).hostname.toLowerCase());
  } catch {
    /* validated elsewhere */
  }
  for (const m of src.matchAll(/https?:\/\/([a-z0-9._-]+)/gi)) {
    const host = m[1].toLowerCase();
    if (!allowed.has(host)) errors.push(`mentions unexpected URL host: ${host}`);
  }
  return errors;
}

export function checkBundleSize(bytes) {
  return bytes > MAX_BUNDLE_BYTES ? [`bundle is ${bytes} bytes, over the ${MAX_BUNDLE_BYTES}-byte limit`] : [];
}
