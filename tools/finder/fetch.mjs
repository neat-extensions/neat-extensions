// Polite, cached HTTP for the finder: one request at a time per host with a jittered
// gap, Retry-After honoured, a 24 h on-disk cache (finder/.cache/, git-ignored), no
// cookies except declining Google's consent banner, no login. Block pages are detected,
// never "solved".
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const DAY = 24 * 60 * 60 * 1000;
const GAP_MS = { "chromewebstore.google.com": 2500, "clients2.google.com": 1500, "extscope.org": 4000 };
const last = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Blocked extends Error {}

export function createFetcher({ cacheDir, log = () => {} }) {
  const file = (url) => path.join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.json`);
  const stats = { network: 0, cache: 0, blocked: 0 };

  async function polite(host) {
    const gap = GAP_MS[host] ?? 3000;
    const wait = (last.get(host) || 0) + gap + Math.random() * gap * 0.4 - Date.now();
    if (wait > 0) await sleep(wait);
    last.set(host, Date.now());
  }

  /**
   * GET a URL as text (or, with `binary`, return the result of `transform(bytes)` — only that
   * derived JSON is cached). Returns { url, finalUrl, fetchedAt, status, body, cached, cacheFile }.
   */
  async function get(url, { binary = false, transform, maxBytes = 25 * 1024 * 1024 } = {}) {
    await mkdir(cacheDir, { recursive: true });
    const f = file(url);
    try {
      const hit = JSON.parse(await readFile(f, "utf8"));
      if (Date.now() - Date.parse(hit.fetchedAt) < DAY) {
        stats.cache++;
        return { ...hit, cached: true, cacheFile: path.basename(f) };
      }
    } catch {
      /* miss */
    }
    const host = new URL(url).host;
    for (let attempt = 0; attempt < 3; attempt++) {
      await polite(host);
      stats.network++;
      let res;
      try {
        res = await fetch(url, {
          headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9", cookie: host.endsWith("google.com") ? "SOCS=CAI" : "" },
          redirect: "follow",
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        log(`  network error ${e.message} — ${url}`);
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get("retry-after")) || 30 * (attempt + 1);
        log(`  ${res.status} from ${host}; waiting ${ra}s`);
        await sleep(Math.min(ra, 300) * 1000);
        continue;
      }
      const finalUrl = res.url;
      let body;
      if (binary) {
        const len = Number(res.headers.get("content-length") || 0);
        if (!res.ok) body = { error: `HTTP ${res.status}` };
        else if (len > maxBytes) {
          await res.body?.cancel();
          body = { error: `package is ${(len / 1048576).toFixed(1)} MB — over the ${maxBytes / 1048576} MB limit, not downloaded` };
        } else {
          try {
            body = transform(new Uint8Array(await res.arrayBuffer()));
          } catch (e) {
            body = { error: e.message };
          }
        }
      } else {
        body = await res.text();
        if (res.status === 403 || /\/sorry\/|unusual traffic from your computer network|cf-challenge|Just a moment\.\.\./i.test(finalUrl + body.slice(0, 20000))) {
          stats.blocked++;
          throw new Blocked(`${host} blocked the request (HTTP ${res.status})`);
        }
      }
      const rec = { url, finalUrl, fetchedAt: new Date().toISOString(), status: res.status, body };
      if (res.ok) await writeFile(f, JSON.stringify(rec));
      return { ...rec, cached: false, cacheFile: path.basename(f) };
    }
    stats.blocked++;
    throw new Blocked(`${host} kept refusing (rate limited) — ${url}`);
  }

  return { get, stats };
}
