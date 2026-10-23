// Storage layout (chrome.storage.local). Everything the extension remembers
// lives on this device; nothing is synced or sent anywhere.
import { validateRules } from "./schema.js";
import { compareVersions } from "./version.js";

export const KEYS = {
  settings: "settings", // { enabled, toggles: {id: bool}, allowlist: [string], aliases: {UCid: "@handle"} }
  rules: "rules", // last good remote rules document
  rulesMeta: "rulesMeta", // { lastAttempt, lastSuccess, status, version }
  diagnostics: "diagnostics", // [{ kind, ruleId, build, page, at, count }]
  review: "review", // { eligible, dismissed }
};
export const ACTIVITY_PREFIX = "act:";
export const REVIEW_AFTER_DAYS = 10;
export const MAX_DIAGNOSTICS = 50;

export function normalizeSettings(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const toggles = {};
  if (s.toggles && typeof s.toggles === "object") {
    for (const [k, v] of Object.entries(s.toggles)) if (typeof v === "boolean") toggles[k] = v;
  }
  const allowlist = Array.isArray(s.allowlist) ? s.allowlist.filter((x) => typeof x === "string").slice(0, 500) : [];
  // UC… id → @handle pairs learned on channel pages, so either form of an allowed channel matches.
  const aliases = {};
  if (s.aliases && typeof s.aliases === "object") {
    for (const [k, v] of Object.entries(s.aliases)) if (typeof v === "string" && Object.keys(aliases).length < 500) aliases[k] = v;
  }
  return { enabled: s.enabled !== false, toggles, allowlist, aliases };
}

/** Effective on/off for a rule or feature: the user's choice, else its default. */
export function isOn(settings, item) {
  const v = settings.toggles[item.id];
  return typeof v === "boolean" ? v : item.default;
}

/**
 * Pick which rules to run: the stored remote rules if they validate for this
 * site and are newer than the bundled copy, otherwise the bundled copy.
 */
export function pickRules(bundled, stored, site) {
  if (stored && validateRules(stored, { site }).ok && compareVersions(stored.version, bundled.version) > 0) {
    // Remote rules may fix locators and add rules, but never re-label a shipped
    // rule or flip its default: what users agreed to at install stays put.
    const shipped = new Map(bundled.rules.map((r) => [r.id, r]));
    const rules = stored.rules.map((r) => (shipped.has(r.id) ? { ...r, label: shipped.get(r.id).label, default: shipped.get(r.id).default, group: shipped.get(r.id).group } : r));
    return { doc: { ...stored, rules }, source: "remote" };
  }
  return { doc: bundled, source: "bundled" };
}

export function todayKey(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${ACTIVITY_PREFIX}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function countActivityDays(all) {
  return Object.keys(all).filter((k) => k.startsWith(ACTIVITY_PREFIX)).length;
}
