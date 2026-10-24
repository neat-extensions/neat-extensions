// Remote rules updater. Fetches ONE configured https URL (plus its detached
// signature at URL + ".sig") — or, only when that attempt fails, one fixed
// fallback URL serving the same file from another host — verifies the signature with the shipped public key,
// validates strictly, accepts only a newer version for the same site, and
// otherwise keeps the last good rules. Written against injected fetch/storage
// so it is unit-testable.
import { parseRulesText, validateRulesUrl, isPlaceholderUrl, LIMITS } from "./schema.js";
import { verifyRules, isPublicJwk } from "./signature.js";
import { compareVersions } from "./version.js";
import { KEYS, pickRules } from "./settings.js";

export const MIN_REFETCH_MS = 60 * 60 * 1000; // scheduled/startup refresh: at most hourly
export const MIN_RECHECK_MS = 60 * 60 * 1000; // broken-rule recheck: also at most hourly (as the listing promises)

/**
 * @param {{site: string, bundled: object, rulesUrl: string, fallbackUrl?: string, publicKey: object|null,
 *          storage: {get: Function, set: Function}, fetchImpl: Function, now?: () => number}} deps
 */
export function createUpdater({ site, bundled, rulesUrl, fallbackUrl = "", publicKey, storage, fetchImpl, now = Date.now }) {
  const urlCheck = validateRulesUrl(rulesUrl);
  const hasKey = isPublicJwk(publicKey);
  const configured = urlCheck.ok && !isPlaceholderUrl(rulesUrl) && hasKey;
  // The fallback obeys the same checks and is tried only after the primary attempt fails.
  const fallbackCheck = fallbackUrl ? validateRulesUrl(fallbackUrl) : { ok: false };
  const sources = [urlCheck.url];
  if (fallbackCheck.ok && !isPlaceholderUrl(fallbackUrl) && fallbackCheck.url.href !== urlCheck.url?.href) sources.push(fallbackCheck.url);
  let inflight = null;

  async function writeMeta(patch) {
    const { [KEYS.rulesMeta]: meta = {} } = await storage.get(KEYS.rulesMeta);
    await storage.set({ [KEYS.rulesMeta]: { ...meta, ...patch } });
  }

  async function run(reason) {
    const t = now();
    if (!configured) {
      const why = !urlCheck.ok ? `invalid-url: ${urlCheck.error}` : !hasKey ? "not-configured (no signing key)" : "not-configured";
      await writeMeta({ status: why, lastAttempt: t });
      return { updated: false, status: "not-configured" };
    }
    const got = await storage.get([KEYS.rules, KEYS.rulesMeta]);
    const meta = got[KEYS.rulesMeta] || {};
    const minGap = reason === "recheck" ? MIN_RECHECK_MS : MIN_REFETCH_MS;
    if (reason !== "install" && reason !== "manual" && meta.lastAttempt && t - meta.lastAttempt < minGap) {
      return { updated: false, status: "throttled" };
    }
    const current = pickRules(bundled, got[KEYS.rules], site).doc;

    const failures = [];
    for (const url of sources) {
      const r = await attempt(url, current);
      if (r.doc) {
        await storage.set({ [KEYS.rules]: r.doc });
        await writeMeta({ status: `updated to ${r.doc.version}`, lastAttempt: t, lastSuccess: t, version: r.doc.version });
        return { updated: true, status: "updated", version: r.doc.version };
      }
      if (r.verified) {
        await writeMeta({ status: r.status, lastAttempt: t });
        return { updated: false, status: r.status };
      }
      failures.push(r.status);
    }
    const status = failures.length > 1 ? `${failures[0]}; fallback ${failures[1]}` : failures[0];
    await writeMeta({ status, lastAttempt: t });
    return { updated: false, status };
  }

  /** One source: {doc} = newer valid rules, {verified} = signed and valid but not newer, else the failure's {status}. */
  async function attempt(url, current) {
    try {
      const init = { method: "GET", credentials: "omit", cache: "no-cache", redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(15000) };
      const [body, sig] = await Promise.all([fetchCapped(fetchImpl, url.href, init, LIMITS.maxBytes), fetchCapped(fetchImpl, `${url.href}.sig`, init, 512)]);
      if (!(await verifyRules(publicKey, body, new TextDecoder().decode(sig)))) throw new Error("signature does not verify");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const parsed = parseRulesText(text, { site });
      if (!parsed.ok) return { status: `rejected: ${parsed.errors.slice(0, 3).join("; ")}` };
      if (compareVersions(parsed.doc.version, current.version) <= 0) return { verified: true, status: `up-to-date (${current.version})` };
      return { doc: parsed.doc };
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).slice(0, 120);
      return { status: /signature|larger than/.test(msg) ? `rejected: ${msg}` : `fetch failed: ${msg}` };
    }
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

/** GET a resource and read at most `max` bytes; anything bigger is refused, not truncated. */
async function fetchCapped(fetchImpl, url, init, max) {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`http ${res.status} for ${url.endsWith(".sig") ? "signature" : "rules"}`);
  const declared = Number(res.headers && res.headers.get && res.headers.get("content-length"));
  if (declared > max) throw new Error(`response larger than ${max} bytes`);
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        reader.cancel().catch(() => {});
        throw new Error(`response larger than ${max} bytes`);
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > max) throw new Error(`response larger than ${max} bytes`);
  return buf;
}
