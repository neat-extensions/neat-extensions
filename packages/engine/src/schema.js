// Strict validator for rules files. Rules are DATA that describe what to hide;
// they can never carry code. Anything outside the schema is rejected outright —
// unknown keys, wrong types, code-looking strings, CSS that could escape its rule.
import { parseVersion, compareVersions, ENGINE_VERSION } from "./version.js";

export const LIMITS = {
  maxBytes: 64 * 1024,
  maxRules: 100,
  maxLocators: 3,
  maxSelector: 500,
  maxText: 80,
};

const TOP_KEYS = ["version", "site", "minEngineVersion", "rules"];
const RULE_KEYS = ["id", "label", "default", "group", "locators"];
const LOCATOR_KEYS = {
  css: ["type", "selector"],
  text: ["type", "container", "label", "match"],
  structural: ["type", "anchor", "container"],
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const SITE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Characters that could close a CSS rule, open an at-rule, escape, or smuggle markup.
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CSS_FORBIDDEN = /[{};@\\<`\u0000-\u001f\u007f]|\/\*|\*\//;
const CSS_FORBIDDEN_FUNCS = /\b(?:url|image-set|image|expression|element|attr|env|var|src)\s*\(/i;
// Strings that look like script, wherever they appear.
const CODE_LIKE = [
  /javascript\s*:/i,
  /data\s*:/i,
  /vbscript\s*:/i,
  /<\s*\/?\s*script/i,
  /=>/,
  /\$\{/,
  /\bfunction\b/i,
  /\beval\b/i,
  /\bnew\s+Function\b/i,
  /\bimport\s*\(/i,
  /\brequire\s*\(/i,
  /\b(?:document|window|globalThis|chrome|self)\s*\./i,
  /\b(?:setTimeout|setInterval|fetch|XMLHttpRequest)\b/i,
  /\bon[a-z]+\s*=/i,
];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function checkKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
  }
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) errors.push(`${where}: missing key "${k}"`);
  }
}

export function looksLikeCode(s) {
  return CODE_LIKE.some((re) => re.test(s));
}

function checkText(v, where, errors, max = LIMITS.maxText) {
  if (typeof v !== "string" || v.trim().length === 0) return errors.push(`${where}: must be a non-empty string`);
  if (v.length > max) return errors.push(`${where}: longer than ${max} characters`);
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f<>]/.test(v)) return errors.push(`${where}: contains control characters or markup`);
  if (looksLikeCode(v)) errors.push(`${where}: looks like code`);
}

function balanced(s) {
  const pairs = { ")": "(", "]": "[" };
  const stack = [];
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") stack.push(ch);
    else if (ch === ")" || ch === "]") {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }
  return quote === null && stack.length === 0;
}

/** Syntactic safety check for a CSS selector string. The browser later confirms it parses. */
export function checkSelector(v, where, errors) {
  if (typeof v !== "string" || v.trim().length === 0) return errors.push(`${where}: must be a non-empty selector`);
  if (v.length > LIMITS.maxSelector) return errors.push(`${where}: selector longer than ${LIMITS.maxSelector}`);
  if (CSS_FORBIDDEN.test(v)) return errors.push(`${where}: selector contains a forbidden character`);
  if (CSS_FORBIDDEN_FUNCS.test(v)) return errors.push(`${where}: selector uses a forbidden function`);
  if (looksLikeCode(v)) return errors.push(`${where}: selector looks like code`);
  if (!balanced(v)) errors.push(`${where}: selector has unbalanced brackets or quotes`);
}

function checkLocator(loc, where, errors) {
  if (!isPlainObject(loc)) return errors.push(`${where}: must be an object`);
  const allowed = LOCATOR_KEYS[loc.type];
  if (!allowed) return errors.push(`${where}: unknown locator type ${JSON.stringify(loc.type)}`);
  checkKeys(loc, allowed, where, errors);
  if (loc.type === "css") checkSelector(loc.selector, `${where}.selector`, errors);
  if (loc.type === "text") {
    checkSelector(loc.container, `${where}.container`, errors);
    checkSelector(loc.label, `${where}.label`, errors);
    checkText(loc.match, `${where}.match`, errors);
  }
  if (loc.type === "structural") {
    checkSelector(loc.anchor, `${where}.anchor`, errors);
    checkSelector(loc.container, `${where}.container`, errors);
  }
}

/**
 * Validate a parsed rules document.
 * @param {unknown} doc
 * @param {{site?: string, engineVersion?: string}} [opts]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRules(doc, opts = {}) {
  const errors = [];
  if (!isPlainObject(doc)) return { ok: false, errors: ["root: must be an object"] };
  checkKeys(doc, TOP_KEYS, "root", errors);
  if (!parseVersion(doc.version)) errors.push("version: must be MAJOR.MINOR.PATCH");
  if (!parseVersion(doc.minEngineVersion)) errors.push("minEngineVersion: must be MAJOR.MINOR.PATCH");
  else if (compareVersions(doc.minEngineVersion, opts.engineVersion ?? ENGINE_VERSION) > 0)
    errors.push(`minEngineVersion: needs engine ${doc.minEngineVersion}`);
  if (typeof doc.site !== "string" || !SITE_RE.test(doc.site)) errors.push("site: invalid");
  else if (opts.site && doc.site !== opts.site) errors.push(`site: expected "${opts.site}", got "${doc.site}"`);

  if (!Array.isArray(doc.rules) || doc.rules.length === 0) errors.push("rules: must be a non-empty array");
  else if (doc.rules.length > LIMITS.maxRules) errors.push(`rules: more than ${LIMITS.maxRules}`);
  else {
    const seen = new Set();
    doc.rules.forEach((rule, i) => {
      const where = `rules[${i}]`;
      if (!isPlainObject(rule)) return errors.push(`${where}: must be an object`);
      checkKeys(rule, RULE_KEYS, where, errors);
      if (typeof rule.id !== "string" || !ID_RE.test(rule.id)) errors.push(`${where}.id: invalid`);
      else if (seen.has(rule.id)) errors.push(`${where}.id: duplicate "${rule.id}"`);
      else seen.add(rule.id);
      checkText(rule.label, `${where}.label`, errors);
      checkText(rule.group, `${where}.group`, errors, 40);
      if (typeof rule.default !== "boolean") errors.push(`${where}.default: must be boolean`);
      if (!Array.isArray(rule.locators) || rule.locators.length < 1 || rule.locators.length > LIMITS.maxLocators)
        errors.push(`${where}.locators: must hold 1 to ${LIMITS.maxLocators} locators`);
      else rule.locators.forEach((loc, j) => checkLocator(loc, `${where}.locators[${j}]`, errors));
    });
  }
  return { ok: errors.length === 0, errors };
}

/** Parse + validate raw text in one step, with a size cap. */
export function parseRulesText(text, opts) {
  if (typeof text !== "string") return { ok: false, errors: ["body: not text"] };
  if (text.length > LIMITS.maxBytes) return { ok: false, errors: [`body: larger than ${LIMITS.maxBytes} bytes`] };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["body: not valid JSON"] };
  }
  const res = validateRules(doc, opts);
  return res.ok ? { ok: true, errors: [], doc } : res;
}

/** The rules URL must be plain https with no credentials. */
export function validateRulesUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "not a URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "rules URL must use https" };
  if (u.username || u.password) return { ok: false, error: "rules URL must not contain credentials" };
  if (!u.hostname) return { ok: false, error: "rules URL needs a host" };
  return { ok: true, url: u };
}

/** The default placeholder host means "no remote rules configured yet": never fetch it. */
export function isPlaceholderUrl(url) {
  try {
    return new URL(url).hostname === "rules_host";
  } catch {
    return true;
  }
}
