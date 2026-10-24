// The public help and Pro pages: every link and image resolves; nothing points
// at a placeholder; the help page has the seven steps with real images.
import { test, expect, ROOT } from "./helpers.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import app from "../../apps/record/app.config.js";
import { SITE_URL, SUPPORT_EMAIL } from "../../brand.config.js";

const DOCS = path.join(ROOT, "docs", "record");

for (const page of ["help.html", "pro.html", "privacy.html"]) {
  test(`${page}: every link and image resolves`, async ({ request }) => {
    const html = readFileSync(path.join(DOCS, page), "utf8");
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith("#") && !u.startsWith("data:"));
    expect(refs.length).toBeGreaterThan(3);
    for (const u of refs) {
      expect(u, "no placeholder links").not.toMatch(/PAYMENT_LINK|REPLACE|OAUTH_CLIENT_ID|RULES_HOST/);
      if (u.startsWith("mailto:")) {
        expect(u).toBe(`mailto:${SUPPORT_EMAIL}`);
        continue;
      }
      if (/^https?:/.test(u)) {
        const res = await request.get(u, { maxRedirects: 5, timeout: 30_000, failOnStatusCode: false });
        // The published pages themselves are checked locally (they may not be deployed yet).
        if (u.startsWith(`${SITE_URL}record/`)) {
          expect(existsSync(path.join(DOCS, u.slice(`${SITE_URL}record/`.length).split("#")[0])), u).toBe(true);
          continue;
        }
        expect(res.status(), u).toBeLessThan(400);
      } else {
        expect(existsSync(path.join(DOCS, u.split("#")[0])), `${page} → ${u}`).toBe(true);
      }
    }
  });
}

test("help: seven numbered steps, each with a real screenshot", () => {
  const html = readFileSync(path.join(DOCS, "help.html"), "utf8");
  const steps = [...html.matchAll(/<section class="step" id="step-(\d)">/g)].map((m) => Number(m[1]));
  expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7]);
  // The order the extension works in: Record first, then the box is drawn.
  const titles = [...html.matchAll(/<section class="step"[^>]*>.*?<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  expect(titles[1]).toMatch(/Press Record/);
  expect(titles[2]).toMatch(/Draw your box/);
  for (const m of html.matchAll(/<img class="shot" src="([^"]+)"/g)) {
    const buf = readFileSync(path.join(DOCS, m[1]));
    expect(buf.readUInt32BE(16), m[1]).toBe(1280); // PNG width
    expect(buf.readUInt32BE(20), m[1]).toBe(800);
  }
  expect(html).toContain("Good, Better or Best?");
  // The four ways, in the panel's order, in plain words, with the Window sound note.
  const ways = [...html.matchAll(/<div class="way">.*?<b>([^<]+)<\/b>/g)].map((m) => m[1]);
  expect(ways).toEqual(["Draw a box", "Screen", "Window", "This page"]);
  expect(html).toContain("Only what is inside the box goes in the video. Everything outside stays out.");
  expect(html).toContain("Sound is off in Window mode — your browser can't record one window's sound. Use Screen or This page for sound.");
  expect(html).not.toMatch(/(^|[^A-Za-z])Tab([^A-Za-z]|$)/); // "This page" everywhere a reader can see
  // Works in Edge too: "your browser", not "Chrome", in the steps; and how to set the shortcut if a browser left it unset.
  expect(html).not.toMatch(/top right of Chrome|Chrome asks|Chrome can't|Chrome doesn't/);
  expect(html).toContain("edge://extensions/shortcuts");
});

test("every page offers the support email", () => {
  for (const page of ["help.html", "pro.html", "privacy.html"]) expect(readFileSync(path.join(DOCS, page), "utf8"), page).toContain(`mailto:${SUPPORT_EMAIL}`);
});

test("pro: the poster and a Buy button that opens the Stripe Payment Link", () => {
  const html = readFileSync(path.join(DOCS, "pro.html"), "utf8");
  expect(html).toMatch(/<img class="shot poster" src="poster.png"/);
  expect(app.buyUrl).toMatch(/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]+$/);
  expect(html).toContain(`<a class="btn" id="buy" href="${app.buyUrl}">Get Pro — ${app.price} once</a>`);
  expect(html).not.toMatch(/data-pending="payment-link"/);
  expect(readFileSync(path.join(ROOT, "store", "record", "screenshots", "4-free-vs-pro.png")).equals(readFileSync(path.join(DOCS, "poster.png")))).toBe(true);
});
