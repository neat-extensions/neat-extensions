// Pure parsers for public Chrome Web Store pages (and the extscope.org fallback).
// They work on the page's visible text, line by line, and return the exact source
// line ("evidence") for every number so the report can be traced back to the page.
import { unzipSync, strFromU8 } from "fflate";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** Visible text of an HTML page as trimmed, non-empty lines. */
export function htmlToLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** "10,000" → 10000, "1.2K" → 1200, "3M" → 3000000, "1,000,000+" → 1000000 */
export function parseCount(s) {
  const m = /^([\d.,]+)\s*([KM])?\+?$/i.exec(String(s).trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = { K: 1e3, M: 1e6 }[(m[2] || "").toUpperCase()] || 1;
  return Math.round(n * mult);
}

const DATE_RE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}$/;
export const isDate = (s) => DATE_RE.test(s);
export const toIsoDate = (s) => {
  const d = new Date(`${s} UTC`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Search results page → listings in page order: [{slug, id, url}] (unique by id). */
export function parseSearch(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/detail\/([a-z0-9-]+)\/([a-p]{32})/g)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ slug: m[1], id: m[2], url: `https://chromewebstore.google.com/detail/${m[1]}/${m[2]}` });
  }
  return out;
}

/** Listing (detail) page → name, users, rating, ratingCount, updated, publisher, version, with evidence lines. */
export function parseDetail(html) {
  const lines = htmlToLines(html);
  const title = /<title>([^<]*)<\/title>/i.exec(html);
  const name = title ? htmlToLines(title[1]).join(" ").replace(/\s*-\s*Chrome Web Store\s*$/, "") : null;
  const ev = {};
  const r = { name, users: null, rating: null, ratingCount: 0, updated: null, publisher: null, version: null, evidence: ev };
  // The header block (before "Overview") holds rating, count and users; later blocks hold "You might also like" items.
  const end = lines.indexOf("Overview") > 0 ? lines.indexOf("Overview") : lines.length;
  for (let i = 0; i < end; i++) {
    const l = lines[i];
    if (r.users === null) {
      const u = /^([\d.,]+[KM]?\+?) users?$/i.exec(l);
      if (u) {
        r.users = parseCount(u[1]);
        ev.users = l;
      }
    }
    if (r.rating === null && /^[0-5](\.\d)?$/.test(l)) {
      const near = lines.slice(i + 1, i + 4).find((x) => /^[\d.,]+[KM]? ratings?$/i.test(x));
      if (near) {
        r.rating = parseFloat(l);
        r.ratingCount = parseCount(near.split(" ")[0]);
        r.ratingCountText = near.split(" ")[0]; // as shown ("1.1K"): the report quotes this, not a made-up exact number
        ev.rating = `${l} (${near})`;
      }
    }
  }
  const after = (label, ok = () => true) => {
    const i = lines.indexOf(label);
    return i >= 0 && lines[i + 1] && ok(lines[i + 1]) ? lines[i + 1] : null;
  };
  const upd = after("Updated", isDate);
  if (upd) {
    r.updated = toIsoDate(upd);
    ev.updated = `Updated ${upd}`;
  }
  const pub = after("Offered by");
  if (pub) {
    r.publisher = pub;
    ev.publisher = `Offered by ${pub}`;
  } else {
    // No "Offered by" line when the developer lists a website: use its domain (never the contact email).
    const site = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>(?:\s|<[^>]+>)*Website(?:\s|<[^>]+>)*<\/a>/i.exec(html);
    if (site) {
      try {
        r.publisher = new URL(site[1].replace(/&amp;/g, "&")).hostname.replace(/^www\./, "");
        r.publisherFrom = "developer website";
      } catch {
        /* unparseable link */
      }
    }
  }
  r.version = after("Version");
  return r;
}

/** Reviews page (sorted Recent by default) → up to `max` reviews [{date, text}] (no reviewer names kept). */
export function parseReviews(html, max = 10) {
  const lines = htmlToLines(html);
  const stop = (l) => l === "Load more" || l === "Back to top" || /found this (review to be )?(un)?helpful$/i.test(l) || /^\d+ out of \d+ found this (un)?helpful$/i.test(l);
  // A developer reply is "<developer name>", "Developer", <date>, <reply>: it is not a review,
  // and the name line before it must not end up in the review text.
  const replyAt = (k) => lines[k + 1] === "Developer" && isDate(lines[k + 2] || "");
  const out = [];
  for (let i = 1; i < lines.length && out.length < max; i++) {
    if (!isDate(lines[i]) || lines[i - 1] === "Developer") continue;
    let j = i + 1;
    while (j < lines.length && (lines[j] === "Report illegal content" || lines[j] === "Copy link")) j++;
    const text = [];
    for (; j < lines.length; j++) {
      if (stop(lines[j]) || replyAt(j) || (j + 1 < lines.length && isDate(lines[j + 1]))) break;
      text.push(lines[j]);
    }
    out.push({ date: toIsoDate(lines[i]), text: text.join(" ").slice(0, 600) });
  }
  return out;
}

export const BROKEN_RE = /stopped working|stop working|doesn['’]?t work|does not work|not working anymore|broken/i;

/** CRX2/CRX3 package bytes → declared permissions from manifest.json (only that file is read; nothing is run). */
export function parseCrxManifest(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (strFromU8(u8.subarray(0, 4)) !== "Cr24") throw new Error("not a CRX package");
  const version = dv.getUint32(4, true);
  const zipStart = version === 3 ? 12 + dv.getUint32(8, true) : 16 + dv.getUint32(8, true) + dv.getUint32(12, true);
  const files = unzipSync(u8.subarray(zipStart), { filter: (f) => f.name === "manifest.json" });
  if (!files["manifest.json"]) throw new Error("manifest.json missing");
  const m = JSON.parse(strFromU8(files["manifest.json"]).replace(/^\uFEFF/, ""));
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
  const perms = strs(m.permissions);
  return {
    manifestVersion: m.manifest_version,
    permissions: perms.filter((p) => !/[:/*]/.test(p) && p !== "<all_urls>"),
    hosts: [...new Set([...strs(m.host_permissions), ...perms.filter((p) => /[:/*]/.test(p) || p === "<all_urls>"), ...(m.content_scripts || []).flatMap((c) => strs(c.matches))])],
    optional: strs(m.optional_permissions),
  };
}

/** extscope.org extension page (fallback) → users (rounded), rating, rating count, permissions. */
export function parseExtscope(html) {
  const lines = htmlToLines(html);
  const after = (label) => {
    const i = lines.indexOf(label);
    return i >= 0 ? lines[i + 1] : null;
  };
  const title = /<title>([^<|]*)/i.exec(html);
  const permIdx = lines.indexOf("Permissions");
  const hostIdx = lines.indexOf("Host access");
  return {
    name: title ? htmlToLines(title[1]).join(" ").trim() : null,
    users: parseCount(after("Users") || ""),
    rating: after("Rating") && /^[0-5](\.\d+)?$/.test(after("Rating")) ? parseFloat(after("Rating")) : null,
    ratingCount: parseCount(after("Reviews") || "") ?? 0,
    permissions: permIdx >= 0 && hostIdx > permIdx ? lines.slice(permIdx + 1, hostIdx) : [],
    evidence: { users: `Users ${after("Users")}`, rating: `Rating ${after("Rating")} / Reviews ${after("Reviews")}` },
  };
}
