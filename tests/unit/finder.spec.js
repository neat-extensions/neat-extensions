import { test, expect } from "@playwright/test";
import { zipSync, strToU8 } from "fflate";
import { parseCount, parseSearch, parseDetail, parseReviews, parseCrxManifest } from "../../tools/finder/parse.mjs";
import { capShares, scorePhrase, CAP_SHARE, MIN_DEMAND } from "../../tools/finder/score.mjs";

const NOW = new Date("2026-10-23T12:00:00Z");
const L = (o) => ({ name: "x", rating: 4.6, updated: "2026-09-01", reviews: [], ...o });

test.describe("finder scoring", () => {
  test("no single listing carries more than the cap share of demand", () => {
    const capped = capShares([10_000_000, 10_000, 10_000, 10_000, 10_000]);
    const total = capped.reduce((a, b) => a + b, 0);
    expect(Math.max(...capped) / total).toBeLessThanOrEqual(CAP_SHARE + 1e-6);
    const two = capShares([9e6, 8e6, 1e3, 1e3, 1e3]);
    expect(Math.max(...two) / two.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(CAP_SHARE + 1e-6);
  });

  test("one strong giant + four weak minnows is not a big opportunity", () => {
    const s = scorePhrase([L({ users: 10_000_000 }), ...[1, 2, 3, 4].map(() => L({ users: 2_000, rating: 3.0 }))], NOW);
    expect(s.demandRaw).toBe(10_008_000);
    expect(s.demand).toBeLessThan(20_000);
    expect(s.weakCount).toBe(4);
    expect(s.opportunity).toBeLessThan(16_000);
  });

  test("weakness: low rating, stale, or broken reviews; minimum demand", () => {
    const s = scorePhrase(
      [
        L({ users: 1000, rating: 4.1 }),
        L({ users: 1000, updated: "2025-01-01" }),
        L({ users: 1000, reviews: [{ date: "2026-10-01", text: "It stopped working after the update" }] }),
        L({ users: 1000, reviews: [{ date: "2026-10-01", text: "Doesn’t work on Mac" }] }),
        L({ users: 1000 }),
      ],
      NOW,
    );
    expect(s.top.map((t) => t.weak.length > 0)).toEqual([true, true, true, true, false]);
    expect(s.weakness).toBe(0.8);
    expect(s.opportunity).toBe(4000);
    const tiny = scorePhrase([L({ users: 100, rating: 2 }), L({ users: 100, rating: 2 })], NOW);
    expect(tiny.demand).toBeLessThan(MIN_DEMAND);
    expect(tiny.opportunity).toBe(0);
  });
});

test.describe("finder parsing", () => {
  test("counts", () => {
    expect(parseCount("10,000")).toBe(10000);
    expect(parseCount("1.2K")).toBe(1200);
    expect(parseCount("3M")).toBe(3_000_000);
    expect(parseCount("1,000,000+")).toBe(1_000_000);
    expect(parseCount("abc")).toBeNull();
  });

  test("search keeps page order and de-duplicates", () => {
    const html = '<a href="./detail/b-ext/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">B</a><a href="./detail/a-ext/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">A</a><a href="./detail/b-ext/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">B again</a>';
    expect(parseSearch(html).map((x) => x.slug)).toEqual(["b-ext", "a-ext"]);
  });

  test("detail page fields, with the source line for each number", () => {
    const html = `<title>My Ext - Chrome Web Store</title><div>Themes</div><h1>My Ext</h1><span>3.4</span><span>(</span><span>62 ratings</span><span>)</span><div>Tools</div><div>10,000 users</div><div>Overview</div><p>text</p><div>Version</div><div>1.5.0</div><div>Updated</div><div>April 14, 2025</div><div>Offered by</div><div>Auro</div><div>You might also like</div><div>4.8</div><div>(</div><div>9 ratings</div><div>5,000,000 users</div>`;
    const d = parseDetail(html);
    expect(d).toMatchObject({ name: "My Ext", rating: 3.4, ratingCount: 62, ratingCountText: "62", users: 10000, updated: "2025-04-14", publisher: "Auro", version: "1.5.0" });
    expect(d.evidence).toEqual({ users: "10,000 users", rating: "3.4 (62 ratings)", updated: "Updated April 14, 2025", publisher: "Offered by Auro" });
  });

  test("reviews: date + text, no reviewer names", () => {
    const html = ["Sort by", "Recent", "Jane Doe", "Aug 16, 2026", "Report illegal content", "Copy link", "good for students", "Tim N", "Sep 13, 2025", "Report illegal content", "Copy link", "It does not work !", "Click the icon = 0 result", "1 out of 6 found this helpful", "Load more"].map((t) => `<div>${t}</div>`).join("");
    expect(parseReviews(html)).toEqual([
      { date: "2026-08-16", text: "good for students" },
      { date: "2025-09-13", text: "It does not work ! Click the icon = 0 result" },
    ]);
  });

  test("developer replies are neither reviews nor glued to one (and their names are dropped)", () => {
    const html = ["Ann", "Sep 11, 2026", "Report illegal content", "Copy link", "Doesn't work. Wasted 10 minutes.", "Joel Dev", "Developer", "Sep 13, 2026", "It is not broken, works fine here.", "Report illegal content", "Bob", "Sep 1, 2026", "Report illegal content", "Copy link", "Great", "1 person found this review to be unhelpful", "Load more"].map((t) => `<div>${t}</div>`).join("");
    expect(parseReviews(html)).toEqual([
      { date: "2026-09-11", text: "Doesn't work. Wasted 10 minutes." },
      { date: "2026-09-01", text: "Great" },
    ]);
  });

  test("CRX3 manifest permissions are read without unpacking anything else", () => {
    const zip = zipSync({ "manifest.json": strToU8(JSON.stringify({ manifest_version: 3, permissions: ["storage", "activeTab"], host_permissions: ["https://*.youtube.com/*"], content_scripts: [{ matches: ["<all_urls>"] }] })), "evil.js": strToU8("alert(1)") });
    const header = new Uint8Array(12 + 4);
    header.set(strToU8("Cr24"), 0);
    new DataView(header.buffer).setUint32(4, 3, true);
    new DataView(header.buffer).setUint32(8, 4, true);
    const crx = new Uint8Array(header.length + zip.length);
    crx.set(header);
    crx.set(zip, header.length);
    expect(parseCrxManifest(crx)).toEqual({ manifestVersion: 3, permissions: ["storage", "activeTab"], hosts: ["https://*.youtube.com/*", "<all_urls>"], optional: [] });
    expect(() => parseCrxManifest(strToU8("PK not a crx"))).toThrow(/not a CRX/);
  });
});
