// Scoring for one search phrase from its top-5 listings.
//   demand      = sum of top-5 user counts, after capping any single listing at CAP_SHARE of the total
//                 (one giant incumbent cannot make a phrase look like a market on its own)
//   weakness    = share of the top 5 that are weak: rated under 4.2, OR not updated in 12 months,
//                 OR whose 10 most recent reviews say it stopped working / doesn't work / broken
//   opportunity = demand × weakness, and 0 when capped demand is under MIN_DEMAND
import { BROKEN_RE } from "./parse.mjs";

export const TOP = 5;
export const CAP_SHARE = 0.4;
export const MIN_DEMAND = 500;
export const LOW_RATING = 4.2;
export const STALE_DAYS = 365;

/** Cap every value at `share` of the capped total (iterative, like index weight caps). */
export function capShares(values, share = CAP_SHARE) {
  const v = values.map((x) => Math.max(0, x || 0));
  const s = Math.max(share, 1 / Math.max(1, v.length)); // with n items no cap below 1/n is satisfiable
  for (let iter = 0; iter < 200; iter++) {
    const total = v.reduce((a, b) => a + b, 0);
    if (!total) break;
    let changed = false;
    // Largest first: cap it relative to everything else.
    const order = v.map((x, i) => i).sort((a, b) => v[b] - v[a]);
    for (const i of order) {
      const rest = v.reduce((a, b, j) => (j === i ? a : a + b), 0);
      const max = (s / (1 - s)) * rest;
      if (s < 1 && v[i] > max + 1e-9) {
        v[i] = max;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return v.map((x) => Math.floor(x)); // round down: rounding up could push a capped share over the cap
}

export function weakReasons(listing, now = new Date()) {
  const why = [];
  if (listing.rating !== null && listing.rating !== undefined && listing.rating < LOW_RATING) why.push(`rated ${listing.rating}`);
  if (listing.updated) {
    const days = Math.floor((now - new Date(`${listing.updated}T00:00:00Z`)) / 86400000);
    if (days > STALE_DAYS) why.push(`not updated since ${listing.updated}`);
  }
  const broken = (listing.reviews || []).filter((r) => BROKEN_RE.test(r.text));
  if (broken.length) why.push(`${broken.length}/${listing.reviews.length} recent reviews say it's broken`);
  return why;
}

export function scorePhrase(listings, now = new Date()) {
  const top = listings.filter((l) => l.users !== null && l.users !== undefined).slice(0, TOP);
  const raw = top.map((l) => l.users);
  const capped = capShares(raw);
  const demandRaw = raw.reduce((a, b) => a + b, 0);
  const demand = capped.reduce((a, b) => a + b, 0);
  const reasons = top.map((l) => weakReasons(l, now));
  const weakCount = reasons.filter((r) => r.length).length;
  const weakness = top.length ? weakCount / top.length : 0;
  const eligible = demand >= MIN_DEMAND;
  const opportunity = eligible ? Math.round(demand * weakness) : 0;
  return { top: top.map((l, i) => ({ ...l, cappedUsers: capped[i], weak: reasons[i] })), demandRaw, demand, weakCount, n: top.length, weakness, eligible, opportunity, verdict: verdict({ demand, demandRaw, capped, eligible, weakCount, n: top.length, top, reasons }) };
}

function verdict({ demand, demandRaw, capped, eligible, weakCount, n, top, reasons }) {
  if (!n) return "No listings found — nothing to judge.";
  const k = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${Math.round(x / 1e3)}K` : String(x));
  // One listing holding most of the users is a market owned by one product, not a crowd: say so,
  // and point out when that product is itself weak (the cap hides that case from the score).
  const b = top.reduce((best, l, i) => (l.users > top[best].users ? i : best), 0);
  const owned =
    demandRaw >= 2 * demand && top[b].users >= 0.5 * demandRaw
      ? ` One listing, ${top[b].name}, has ${k(top[b].users)} of the ${k(demandRaw)} users and is ${reasons[b].length ? `weak (${reasons[b][0]}) — worth a look despite the score` : "healthy"}; the cap counts it as ${k(capped[b])}.`
      : "";
  if (!eligible) return `Too small: ${k(demand)} users across the top ${n} after the cap (minimum ${MIN_DEMAND}).${owned}`;
  const leaderWeak = reasons[0].length ? ` — even the #1 (${top[0].name}) is weak: ${reasons[0][0]}` : "";
  if (weakCount / n >= 0.6) return `Open: ${weakCount} of ${n} leaders are weak, ${k(demand)} users to win${leaderWeak}.${owned}`;
  if (weakCount / n >= 0.2) return `Contestable: ${weakCount} of ${n} weak, ${k(demand)} users; needs a clearly better product${leaderWeak}.${owned}`;
  return `Crowded with healthy incumbents (${k(demand)} users, none weak) — skip.${owned}`;
}
