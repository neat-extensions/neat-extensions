// Finder: which Chrome extension niches have real demand and weak incumbents?
// For each phrase in finder/queries.txt: Chrome Web Store search → top 10 listings →
// listing page, recent reviews, declared permissions (from the package manifest) →
// score (see score.mjs) → finder/report-<date>.md ranked by opportunity.
//
//   npm run finder [-- --limit <n>] [-- --only "<phrase>"]
// Raw extraction (with the exact page line behind every number) goes to
// finder/data-<date>.json; fetched pages are cached for a day in finder/.cache/.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFetcher, Blocked } from "./fetch.mjs";
import { parseSearch, parseDetail, parseReviews, parseCrxManifest, parseExtscope, htmlToLines, BROKEN_RE } from "./parse.mjs";
import { scorePhrase, TOP, CAP_SHARE, MIN_DEMAND, LOW_RATING, STALE_DAYS } from "./score.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIR = path.join(ROOT, "finder");
const args = process.argv.slice(2);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const LISTINGS = 10;
const log = (m) => console.log(m);
const { get, stats } = createFetcher({ cacheDir: path.join(DIR, ".cache"), log });
const now = new Date();
const today = now.toISOString().slice(0, 10);

// ---------------------------------------------------------------- queries
const queries = [];
let family = "Other";
for (const raw of (await readFile(path.join(DIR, "queries.txt"), "utf8")).split(/\r?\n/)) {
  const l = raw.trim();
  const fam = /^#\s*Family:\s*(.+)$/i.exec(l);
  if (fam) family = fam[1].trim();
  else if (l && !l.startsWith("#")) queries.push({ phrase: l, family });
}
let todo = queries;
if (opt("--only")) todo = queries.filter((q) => q.phrase === opt("--only"));
if (opt("--limit")) todo = todo.slice(0, Number(opt("--limit")));

// ---------------------------------------------------------------- per listing (memoised: listings recur across phrases)
const notes = new Set();
let storeBlocked = false;
const listingCache = new Map();

/** Every number keeps the page line it came from; verify it is really in the fetched page. */
function traced(page, evidence) {
  const text = htmlToLines(page.body).join("\n");
  for (const [k, line] of Object.entries(evidence)) {
    const parts = String(line).split(/[()]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.every((p) => text.includes(p.replace(/^(Updated|Offered by|Users|Rating|Reviews) /, "")))) throw new Error(`evidence for ${k} not found in ${page.url}`);
  }
}

async function fromExtscope(item) {
  const page = await get(`https://extscope.org/extension/${item.id}`);
  const d = parseExtscope(page.body);
  return { ...d, updated: null, publisher: null, reviews: [], source: "extscope.org", sources: { detail: { url: page.url, fetchedAt: page.fetchedAt, cacheFile: page.cacheFile } } };
}

async function listing(item) {
  if (listingCache.has(item.id)) return listingCache.get(item.id);
  const out = { id: item.id, url: item.url, sources: {} };
  try {
    if (storeBlocked) throw new Blocked("store blocked earlier in this run");
    const page = await get(`${item.url}?hl=en`);
    const d = parseDetail(page.body);
    traced(page, d.evidence);
    Object.assign(out, d, { source: "chromewebstore.google.com" });
    out.sources.detail = { url: page.url, fetchedAt: page.fetchedAt, cacheFile: page.cacheFile };
    const rev = await get(`${item.url}/reviews?hl=en`);
    out.reviews = parseReviews(rev.body, 10);
    out.sources.reviews = { url: rev.url, fetchedAt: rev.fetchedAt, cacheFile: rev.cacheFile };
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    if (!storeBlocked) log(`  ⚠ ${e.message} — falling back to extscope.org`);
    storeBlocked = true;
    notes.add("The Chrome Web Store blocked scraping during this run; listings after that point use extscope.org (users rounded, e.g. 10K; no last-updated date or review text there).");
    try {
      Object.assign(out, await fromExtscope(item));
    } catch (e2) {
      if (!(e2 instanceof Blocked)) throw e2;
      notes.add("extscope.org also refused some requests; those listings have no data.");
      out.error = "store and fallback both blocked";
      out.users = null;
    }
  }
  if (!out.permissions || !out.permissions.length) {
    // Declared permissions are not shown on the listing page; read them from the package's manifest.json.
    const crxUrl = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=141.0&acceptformat=crx2,crx3&x=id%3D${item.id}%26uc`;
    try {
      const p = await get(crxUrl, { binary: true, transform: parseCrxManifest });
      out.manifest = p.body;
      out.sources.manifest = { url: crxUrl, fetchedAt: p.fetchedAt, cacheFile: p.cacheFile };
    } catch (e) {
      out.manifest = { error: e.message };
    }
  }
  listingCache.set(item.id, out);
  return out;
}

// ---------------------------------------------------------------- run
const results = [];
for (const [i, q] of todo.entries()) {
  log(`[${i + 1}/${todo.length}] ${q.phrase}`);
  const searchUrl = `https://chromewebstore.google.com/search/${encodeURIComponent(q.phrase)}?hl=en`;
  let items;
  let searchSource;
  try {
    if (storeBlocked) throw new Blocked("store blocked earlier in this run");
    const page = await get(searchUrl);
    items = parseSearch(page.body).slice(0, LISTINGS);
    searchSource = { url: page.url, fetchedAt: page.fetchedAt, cacheFile: page.cacheFile };
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    storeBlocked = true;
    notes.add("Search results could not be fetched for some phrases (store blocked); those phrases are listed as not scored.");
    results.push({ ...q, error: e.message, score: null, listings: [] });
    continue;
  }
  const listings = [];
  for (const item of items) {
    try {
      listings.push(await listing(item));
    } catch (e) {
      listings.push({ id: item.id, url: item.url, users: null, error: e.message, sources: {} });
    }
  }
  results.push({ ...q, searchSource, listings, score: scorePhrase(listings, now) });
}

// ---------------------------------------------------------------- report
const fmt = (n) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));
const esc = (s) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
const ranked = results.filter((r) => r.score).sort((a, b) => b.score.opportunity - a.score.opportunity || b.score.demand - a.score.demand);
const permsOf = (l) => {
  if (l.permissions && l.permissions.length) return l.permissions.join(", ") + " (extscope)";
  const m = l.manifest;
  if (!m) return "—";
  if (m.error) return `unknown (${m.error})`;
  const all = [...m.permissions, ...m.hosts];
  return all.length ? all.join(", ") : "none";
};

const md = [];
md.push(`# Finder report — ${today}`, "");
md.push(`${results.length} phrases from \`finder/queries.txt\`. For each: Chrome Web Store search (top ${LISTINGS} listings), each listing's page, its 10 most recent reviews (English, sorted by Recent) and its declared permissions (read from the package's \`manifest.json\` via Google's public update server; nothing is run).`, "");
md.push("**Scoring** (top 5 listings per phrase):", "");
md.push(`- **demand** = sum of the top-${TOP} user counts, with any single listing capped at ${CAP_SHARE * 100}% of the total, so one giant incumbent cannot make a phrase look big on its own. Raw (uncapped) sums are shown too.`);
md.push(`- **weakness** = share of the top ${TOP} that are rated under ${LOW_RATING}, OR not updated in ${STALE_DAYS} days, OR whose 10 most recent reviews match \`${BROKEN_RE.source}\`.`);
md.push(`- **opportunity** = demand × weakness; 0 when capped demand is under ${MIN_DEMAND} users.`, "");
md.push(`Every number links to the page it was read from (fetched ${today}; cached in \`finder/.cache/\`, raw extraction with the exact source line per number in \`finder/data-${today}.json\`). Requests: ${stats.network} network, ${stats.cache} from cache, ${stats.blocked} blocked.`, "");
if (notes.size) md.push("**Notes:**", "", ...[...notes].map((n) => `- ${n}`), "");
else md.push("**Notes:** the Chrome Web Store served every page; no fallback source was needed.", "");

md.push("## Ranking", "", "| # | Phrase | Family | Opportunity | Demand (capped / raw) | Weak | Verdict |", "|---|---|---|---:|---:|:-:|---|");
ranked.forEach((r, i) => {
  const s = r.score;
  md.push(`| ${i + 1} | [${esc(r.phrase)}](#${r.phrase.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/ /g, "-")}) | ${esc(r.family)} | ${fmt(s.opportunity)} | ${fmt(s.demand)} / ${fmt(s.demandRaw)} | ${s.weakCount}/${s.n} | ${esc(s.verdict)} |`);
});
for (const r of results.filter((x) => !x.score)) md.push(`| — | ${esc(r.phrase)} | ${esc(r.family)} | not scored | — | — | ${esc(r.error)} |`);
md.push("");

md.push("## Per phrase", "");
for (const r of ranked) {
  const s = r.score;
  md.push(`### ${r.phrase}`, "");
  md.push(`${s.verdict}  `, `Search: [${r.searchSource.url}](${r.searchSource.url}) · opportunity **${fmt(s.opportunity)}** = demand ${fmt(s.demand)} × weakness ${s.weakCount}/${s.n}`, "");
  md.push("| # | Listing | Users (capped) | Rating | Ratings | Updated | Publisher | Permissions | Weak because | Recent reviews |", "|---|---|---:|---:|---:|---|---|---|---|---|");
  r.listings.forEach((l, i) => {
    const inTop = s.top.find((t) => t.id === l.id);
    const users = inTop && inTop.cappedUsers !== l.users ? `${fmt(l.users)} (${fmt(inTop.cappedUsers)})` : fmt(l.users);
    const revs = l.reviews && l.reviews.length ? `${l.reviews.length}, ${l.reviews[l.reviews.length - 1].date} → ${l.reviews[0].date}` : "—";
    const src = l.sources.detail ? `[${esc(l.name)}](${l.sources.detail.url})` : esc(l.name || l.id);
    const weak = inTop ? (inTop.weak.length ? inTop.weak.join("; ") : "—") : "(not in top 5)";
    md.push(`| ${i + 1} | ${src}${l.source === "extscope.org" ? " *(extscope)*" : ""} | ${users} | ${l.rating ?? "—"} | ${l.ratingCountText ?? fmt(l.ratingCount)} | ${l.updated ?? "—"} | ${esc(l.publisher)} | ${esc(permsOf(l))} | ${esc(weak)} | ${l.sources.reviews ? `[${revs}](${l.sources.reviews.url})` : revs} |`);
  });
  const quotes = s.top.flatMap((l) => (l.reviews || []).filter((rv) => BROKEN_RE.test(rv.text)).slice(0, 1).map((rv) => `- *${esc(l.name)}*, ${rv.date}: “${esc(rv.text.slice(0, 140))}${rv.text.length > 140 ? "…" : ""}”`));
  if (quotes.length) md.push("", "Broken-sounding recent reviews (one per listing, reviewer names not kept):", "", ...quotes);
  md.push("");
}

await writeFile(path.join(DIR, `report-${today}.md`), md.join("\n") + "\n");
await writeFile(path.join(DIR, `data-${today}.json`), JSON.stringify({ generated: now.toISOString(), notes: [...notes], stats, results }, null, 1));
log(`\n✔ finder/report-${today}.md (${ranked.length} scored, ${results.length - ranked.length} not scored); requests: ${JSON.stringify(stats)}`);
