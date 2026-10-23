// Self-check and locator logic, run in a real browser against fixture HTML
// (layout and visibility need a real rendering engine, not a DOM shim).
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const FIXTURE = `file:///${path.join(ROOT, "tests", "fixtures", "selfcheck.html").replace(/\\/g, "/")}`;
let engineBundle;

test.beforeAll(async () => {
  const out = await build({
    stdin: {
      contents: `export * from "./packages/engine/src/selfcheck.js"; export * from "./packages/engine/src/locators.js"; export * from "./packages/engine/src/css.js";`,
      resolveDir: ROOT,
    },
    bundle: true,
    format: "iife",
    globalName: "Engine",
    write: false,
  });
  engineBundle = out.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.goto(FIXTURE);
  await page.addScriptTag({ content: engineBundle });
});

const ATTR = "data-test-hide";
const rule = (id, ...locators) => ({ id, label: id, default: true, group: "G", locators });

/** Apply rules the way the content script does (stylesheet + marks), then self-check. */
async function applyAndCheck(page, rules, { applyStyles = true, probes = {} } = {}) {
  return page.evaluate(
    ({ rules, ATTR, applyStyles, probes }) => {
      const E = window.Engine;
      const enabled = new Set(rules.map((r) => r.id));
      if (applyStyles) {
        const style = document.createElement("style");
        style.textContent = E.buildStylesheet(rules, enabled, ATTR, (s) => E.selectorIsValid(document, s));
        document.documentElement.append(style);
        for (const r of rules) for (const loc of r.locators) if (loc.type !== "css") for (const el of E.findTargets(document, loc)) E.mark(el, ATTR, r.id);
      }
      return E.selfCheck(document, rules, enabled, { probes });
    },
    { rules, ATTR, applyStyles, probes },
  );
}

test("a working rule hides every target: not broken", async ({ page }) => {
  const [r] = await applyAndCheck(page, [rule("shorts", { type: "css", selector: "section.shelf:has(a[href^='/shorts/'])" })]);
  expect(r).toMatchObject({ id: "shorts", matched: 1, visible: 0, broken: false, degraded: false });
  await expect(page.locator("#shorts-shelf")).toBeHidden();
  await expect(page.locator("#video-shelf")).toBeVisible();
});

test("markup drift: locators match nothing but the independent probe still sees Shorts -> broken", async ({ page }) => {
  const probes = { shorts: [{ selector: "#feed a[href^='/shorts/']" }] };
  const [r] = await applyAndCheck(page, [rule("shorts", { type: "css", selector: "ytd-renamed-shelf" })], { probes });
  expect(r).toMatchObject({ matched: 0, probed: 2, broken: true });
});

test("probe targets inside hidden containers are not visible -> not broken", async ({ page }) => {
  const probes = { grid: [{ selector: "#grid a[href^='/shorts/']" }] };
  const [r] = await applyAndCheck(page, [rule("grid", { type: "structural", anchor: "#grid a[href^='/shorts/']", container: "li.item" })], { probes });
  expect(r).toMatchObject({ probed: 1, visible: 0, broken: false });
});

test("probe text filter: only an exact label counts", async ({ page }) => {
  const probes = { t: [{ selector: "h2.title", text: "Shorts" }] };
  const [r] = await applyAndCheck(page, [rule("t", { type: "css", selector: "section.shelf:has(a[href^='/shorts/'])" })], { probes });
  expect(r).toMatchObject({ probed: 1, visible: 0, broken: false }); // the "Shorts" title is inside the hidden shelf
});

test("recycled node: a marked container that no longer matches is detected and unmarked", async ({ page }) => {
  const out = await page.evaluate((ATTR) => {
    const E = window.Engine;
    const loc = { type: "text", container: "section.shelf", label: "h2.title", match: "Shorts" };
    const shelf = document.querySelector("#shorts-shelf");
    for (const el of E.findTargets(document, loc)) E.mark(el, ATTR, "shorts");
    const before = shelf.getAttribute(ATTR);
    shelf.querySelector("h2").textContent = "Trending"; // the site reuses the node for other content
    const still = E.isTarget(shelf, loc);
    const changed = E.unmark(shelf, ATTR, "shorts");
    return { before, still, changed, after: shelf.getAttribute(ATTR) };
  }, ATTR);
  expect(out).toEqual({ before: "shorts", still: false, changed: true, after: null });
});

test("unmark keeps other rules' tokens", async ({ page }) => {
  const v = await page.evaluate((ATTR) => {
    const E = window.Engine;
    const el = document.querySelector("#video-shelf");
    E.mark(el, ATTR, "a");
    E.mark(el, ATTR, "b");
    E.unmark(el, ATTR, "a");
    return el.getAttribute(ATTR);
  }, ATTR);
  expect(v).toBe("b");
});

test("targets that stay visible are reported broken", async ({ page }) => {
  const [r] = await applyAndCheck(page, [rule("shorts", { type: "css", selector: "section.shelf:has(a[href^='/shorts/'])" })], { applyStyles: false });
  expect(r).toMatchObject({ matched: 1, visible: 1, broken: true });
});

test("a page with no targets is not broken", async ({ page }) => {
  const [r] = await applyAndCheck(page, [rule("none", { type: "css", selector: "ytd-not-on-this-page" })], { applyStyles: false });
  expect(r).toMatchObject({ matched: 0, visible: 0, broken: false });
});

test("no false positive on legitimately zero-size elements", async ({ page }) => {
  const [r] = await applyAndCheck(page, [rule("placeholder", { type: "css", selector: "#empty-placeholder" })], { applyStyles: false });
  expect(r).toMatchObject({ matched: 1, visible: 0, broken: false });
});

test("no false positive on elements the site already hides (display:none ancestor, visibility, opacity)", async ({ page }) => {
  const res = await applyAndCheck(
    page,
    [rule("site-hidden", { type: "css", selector: "#site-hidden" }), rule("ghosts", { type: "css", selector: "section.ghost" })],
    { applyStyles: false },
  );
  for (const r of res) expect(r).toMatchObject({ visible: 0, broken: false });
});

test("display:contents targets count as visible through their children", async ({ page }) => {
  const [r] = await applyAndCheck(page, [rule("contents", { type: "css", selector: "#contents-box" })], { applyStyles: false });
  expect(r).toMatchObject({ visible: 1, broken: true });
  const [fixed] = await applyAndCheck(page, [rule("contents", { type: "css", selector: "#contents-box" })]);
  expect(fixed).toMatchObject({ visible: 0, broken: false });
});

test("stale primary selector + working text fallback = degraded, not broken", async ({ page }) => {
  const [r] = await applyAndCheck(page, [
    rule("shorts", { type: "css", selector: "ytd-old-shorts-shelf" }, { type: "text", container: "section.shelf", label: "h2.title", match: "Shorts" }),
  ]);
  expect(r).toMatchObject({ matched: 1, visible: 0, broken: false, degraded: true });
  await expect(page.locator("#shorts-shelf")).toBeHidden();
  await expect(page.locator("#video-shelf")).toBeVisible();
});

test("text match is exact (a 'Latest Shorts from X' title is not 'Shorts')", async ({ page }) => {
  await page.evaluate(() => (document.querySelector("#video-shelf h2").textContent = "Latest Shorts from somewhere"));
  const [r] = await applyAndCheck(page, [rule("t", { type: "text", container: "section.shelf", label: "h2.title", match: "  shorts " })]);
  expect(r.matched).toBe(1);
  await expect(page.locator("#video-shelf")).toBeVisible();
});

test("structural locator climbs from anchor to container", async ({ page }) => {
  const [r] = await applyAndCheck(page, [rule("grid", { type: "structural", anchor: "#grid a[href^='/shorts/']", container: "li.item" })]);
  expect(r).toMatchObject({ matched: 1, visible: 0, broken: false });
  await expect(page.locator("#grid li").nth(0)).toBeVisible();
  await expect(page.locator("#grid li").nth(1)).toBeHidden();
});

test("incremental pass: content streamed into an existing shelf is found from the added node", async ({ page }) => {
  const found = await page.evaluate(() => {
    const E = window.Engine;
    const shelf = document.createElement("section");
    shelf.className = "shelf";
    document.querySelector("#feed").append(shelf);
    const title = document.createElement("h2");
    title.className = "title";
    title.textContent = "Shorts";
    shelf.append(title); // the label arrives after the container
    const text = E.findTargets(title, { type: "text", container: "section.shelf", label: "h2.title", match: "Shorts" });
    const a = document.createElement("a");
    a.href = "/shorts/eeeeeeeeeee";
    const thumb = document.createElement("img");
    a.append(thumb);
    shelf.append(a);
    const structural = E.findTargets(thumb, { type: "structural", anchor: "a[href^='/shorts/']", container: "section.shelf" });
    return [text.length && text[0] === shelf, structural.length && structural[0] === shelf];
  });
  expect(found).toEqual([true, true]);
});

test("an invalid selector never throws and never hides anything", async ({ page }) => {
  const out = await page.evaluate(() => {
    const E = window.Engine;
    return {
      targets: E.findTargets(document, { type: "css", selector: "a:unknown-pseudo(" }).length,
      valid: E.selectorIsValid(document, "a:unknown-pseudo("),
      css: E.buildStylesheet([{ id: "x", locators: [{ type: "css", selector: "a:unknown-pseudo(" }] }], new Set(["x"]), "data-h", (s) => E.selectorIsValid(document, s)),
    };
  });
  expect(out.targets).toBe(0);
  expect(out.valid).toBe(false);
  expect(out.css).not.toContain("unknown-pseudo");
});

test("the stylesheet only ever contains display:none", async ({ page }) => {
  const css = await page.evaluate(() =>
    window.Engine.buildStylesheet(
      [
        { id: "a", locators: [{ type: "css", selector: "x-a, x-b" }, { type: "text", container: "s", label: "h", match: "m" }] },
        { id: "b", locators: [{ type: "css", selector: "x-c" }] },
        { id: "off", locators: [{ type: "css", selector: "x-off" }] },
      ],
      new Set(["a", "b"]),
      "data-h",
    ),
  );
  for (const line of css.split("\n")) expect(line).toMatch(/^[^{}]+ \{ display: none !important; \}$/);
  expect(css).not.toContain("x-off");
});
