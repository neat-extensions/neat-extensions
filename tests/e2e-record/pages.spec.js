// The public help and Pro pages: every link and image resolves; nothing points
// at a placeholder; the help page has the seven steps with real images.
import { test, expect, ROOT } from "./helpers.js";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const DOCS = path.join(ROOT, "docs", "record");

for (const page of ["help.html", "pro.html", "privacy.html"]) {
  test(`${page}: every link and image resolves`, async ({ request }) => {
    const html = readFileSync(path.join(DOCS, page), "utf8");
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith("#") && !u.startsWith("data:"));
    expect(refs.length).toBeGreaterThan(3);
    for (const u of refs) {
      expect(u, "no placeholder links").not.toMatch(/PAYMENT_LINK|REPLACE|OAUTH_CLIENT_ID|RULES_HOST/);
      if (/^https?:/.test(u)) {
        const res = await request.get(u, { maxRedirects: 5, timeout: 30_000, failOnStatusCode: false });
        // The published pages themselves are checked locally (they may not be deployed yet).
        if (u.startsWith("https://neat-extensions.github.io/neat-extensions/record/")) {
          expect(existsSync(path.join(DOCS, u.split("/record/")[1].split("#")[0])), u).toBe(true);
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
  for (const m of html.matchAll(/<img class="shot" src="([^"]+)"/g)) {
    const buf = readFileSync(path.join(DOCS, m[1]));
    expect(buf.readUInt32BE(16), m[1]).toBe(1280); // PNG width
    expect(buf.readUInt32BE(20), m[1]).toBe(800);
  }
  expect(html).toContain("Good, Better or Best?");
});

test("pro: the poster and a Buy button (disabled until the Payment Link exists)", () => {
  const html = readFileSync(path.join(DOCS, "pro.html"), "utf8");
  expect(html).toMatch(/<img class="shot poster" src="poster.png"/);
  expect(html).toMatch(/id="buy"/);
  expect(readFileSync(path.join(ROOT, "store", "record", "screenshots", "4-free-vs-pro.png")).equals(readFileSync(path.join(DOCS, "poster.png")))).toBe(true);
});
