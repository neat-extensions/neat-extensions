// Remote rules updater. Fetches ONE configured https URL, validates strictly,
// accepts only a newer version for the same site, and otherwise keeps the
// last good rules. Written against injected fetch/storage so it is unit-testable.
import { parseRulesText, validateRulesUrl, isPlaceholderUrl } from "./schema.js";
import { compareVersions } from "./version.js";
import { KEYS, pickRules } from "./settings.js";

export const MIN_REFETCH_MS = 60 * 60 * 1000; // scheduled/startup refresh: at most hourly
export const MIN_RECHECK_MS = 10 * 60 * 1000; // broken-rule recheck: at most every 10 minutes

/**
 * @param {{site: string, bundled: object, rulesUrl: string,
 *          storage: {get: Function, set: Function}, fetchImpl: Function, now?: () => number}} deps
 */
export function createUpdater({ site, bundled, rulesUrl, storage, fetchImpl, now = Date.now }) {
  const urlCheck = validateRulesUrl(rulesUrl);
  const configured = urlCheck.ok && !isPlaceholderUrl(rulesUrl);
  let inflight = null;

  async function writeMeta(patch) {
    const { [KEYS.rulesMeta]: meta = {} } = await storage.get(KEYS.rulesMeta);
    await storage.set({ [KEYS.rulesMeta]: { ...meta, ...patch } });
  }

  async function run(reason) {
    const t = now();
    if (!configured) {
      await writeMeta({ status: urlCheck.ok ? "not-configured" : `invalid-url: ${urlCheck.error}`, lastAttempt: t });
      return { updated: false, status: "not-configured" };
    }
    const got = await storage.get([KEYS.rules, KEYS.rulesMeta]);
    const meta = got[KEYS.rulesMeta] || {};
    const minGap = reason === "recheck" ? MIN_RECHECK_MS : MIN_REFETCH_MS;
    if (reason !== "install" && reason !== "manual" && meta.lastAttempt && t - meta.lastAttempt < minGap) {
      return { updated: false, status: "throttled" };
    }
    const current = pickRules(bundled, got[KEYS.rules], site).doc;

    let status;
    try {
      const res = await fetchImpl(urlCheck.url.href, {
        method: "GET",
        credentials: "omit",
        cache: "no-cache",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const text = await res.text();
      const parsed = parseRulesText(text, { site });
      if (!parsed.ok) {
        status = `rejected: ${parsed.errors.slice(0, 3).join("; ")}`;
      } else if (compareVersions(parsed.doc.version, current.version) <= 0) {
        status = `up-to-date (${current.version})`;
      } else {
        await storage.set({ [KEYS.rules]: parsed.doc });
        await writeMeta({ status: `updated to ${parsed.doc.version}`, lastAttempt: t, lastSuccess: t, version: parsed.doc.version });
        return { updated: true, status: "updated", version: parsed.doc.version };
      }
    } catch (e) {
      status = `fetch failed: ${String(e && e.message ? e.message : e).slice(0, 120)}`;
    }
    await writeMeta({ status, lastAttempt: t });
    return { updated: false, status };
  }

  return {
    configured,
    /** Coalesces concurrent calls so many tabs reporting at once cause one fetch. */
    refresh(reason = "alarm") {
      if (!inflight) inflight = run(reason).finally(() => (inflight = null));
      return inflight;
    },
  };
}
