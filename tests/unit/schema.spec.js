import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateRules, parseRulesText, validateRulesUrl, isPlaceholderUrl, looksLikeCode, LIMITS } from "../../packages/engine/src/schema.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const bundled = JSON.parse(readFileSync(path.join(ROOT, "apps", "youtube", "rules", "rules.json"), "utf8"));
const minimal = () => ({
  version: "1.0.0",
  site: "youtube",
  minEngineVersion: "1.0.0",
  rules: [{ id: "a", label: "A", default: true, group: "G", locators: [{ type: "css", selector: "div.x" }] }],
});
const errorsOf = (doc, opts) => validateRules(doc, opts).errors.join("\n");

test.describe("rules schema validator", () => {
  test("accepts the bundled YouTube rules", () => {
    expect(validateRules(bundled, { site: "youtube" })).toEqual({ ok: true, errors: [] });
  });

  test("accepts all three locator kinds", () => {
    const d = minimal();
    d.rules[0].locators = [
      { type: "css", selector: "ytd-x:has(> a[title=\"Shorts\"]), y-z" },
      { type: "text", container: "section", label: "h2, #title", match: "Shorts" },
      { type: "structural", anchor: "a[href^=\"/shorts/\"]", container: "li" },
    ];
    expect(validateRules(d).ok).toBe(true);
  });

  test.describe("rejects keys outside the schema", () => {
    for (const [where, mutate] of [
      ["top level", (d) => (d.extra = 1)],
      ["top level __proto__", (d) => Object.defineProperty(d, "__proto__", { value: {}, enumerable: true })],
      ["rule", (d) => (d.rules[0].script = "x")],
      ["rule onload", (d) => (d.rules[0].onload = "alert(1)")],
      ["css locator", (d) => (d.rules[0].locators[0].style = "color:red")],
      ["text locator", (d) => (d.rules[0].locators[0] = { type: "text", container: "a", label: "b", match: "c", run: "x" })],
      ["structural locator", (d) => (d.rules[0].locators[0] = { type: "structural", anchor: "a", container: "b", depth: 3 })],
    ]) {
      test(where, () => {
        const d = minimal();
        mutate(d);
        const r = validateRules(d);
        expect(r.ok).toBe(false);
        expect(r.errors.join()).toMatch(/unknown key/);
      });
    }
    test("parsed JSON with __proto__ key", () => {
      const r = parseRulesText(JSON.stringify(minimal()).replace('"version"', '"__proto__":{"x":1},"version"'));
      expect(r.ok).toBe(false);
      expect(r.errors.join()).toMatch(/unknown key "__proto__"/);
    });
  });

  test("rejects missing keys, wrong types and bad ids", () => {
    const d = minimal();
    delete d.rules[0].group;
    d.rules[0].default = "yes";
    d.rules[0].id = "Bad Id!";
    const e = errorsOf(d);
    expect(e).toMatch(/missing key "group"/);
    expect(e).toMatch(/default: must be boolean/);
    expect(e).toMatch(/\.id: invalid/);
  });

  test("rejects duplicate ids, empty and oversized locator lists", () => {
    const d = minimal();
    d.rules.push({ ...d.rules[0] });
    expect(errorsOf(d)).toMatch(/duplicate/);
    const e = minimal();
    e.rules[0].locators = [];
    expect(errorsOf(e)).toMatch(/1 to 3 locators/);
    e.rules[0].locators = Array(4).fill({ type: "css", selector: "a" });
    expect(errorsOf(e)).toMatch(/1 to 3 locators/);
  });

  test("rejects a different site and a too-new engine requirement", () => {
    expect(errorsOf(minimal(), { site: "reddit" })).toMatch(/site: expected "reddit"/);
    const d = minimal();
    d.minEngineVersion = "9.0.0";
    expect(errorsOf(d)).toMatch(/needs engine 9\.0\.0/);
  });

  test.describe("rejects anything that looks like code", () => {
    const cases = {
      "javascript: URL in label": ["label", "javascript:alert(1)"],
      "arrow function in label": ["label", "x => x"],
      "function keyword in group": ["group", "function(){}"],
      "eval in label": ["label", "eval(atob('x'))"],
      "template literal in label": ["label", "${process.env}"],
      "script tag in label": ["label", "<script>alert(1)</script>"],
      "DOM access in label": ["label", "document.cookie"],
      "chrome API in label": ["label", "chrome.storage.local"],
      "fetch in label": ["label", "fetch('//x')"],
      "inline handler in label": ["label", "img onerror=alert(1)"],
    };
    for (const [name, [field, value]] of Object.entries(cases)) {
      test(name, () => {
        const d = minimal();
        d.rules[0][field] = value;
        expect(validateRules(d).ok).toBe(false);
      });
    }
    const selectorCases = {
      "rule break-out with braces": "a{} body{background:red}",
      "statement separator": "a;b",
      "at-rule": "@import 'x'",
      "url() exfiltration": "a[href^=x]:has(b) ~ c:is(url(https://evil))",
      "expression()": "a:is(expression(alert(1)))",
      "comment smuggling": "a/**/b",
      "backslash escape": "a\\7b",
      "markup": "a<script>",
      "unbalanced brackets": "a[href=\"x\"",
      "unbalanced quotes": "a[title=\"x]",
      "javascript in attribute selector": "a[href=\"javascript:alert(1)\"]",
      "the whole page (html)": "html",
      "the body": "ytd-app, body",
      ":root": ":root",
      "everything (*)": "ytd-app:has(~ *) *",
      "everything via :not": ":not(:has(*))",
      "bare universal with pseudo": "*:not(:has(*))",
      "too many :has()": "a:has(b):has(c):has(d):has(e)",
      "control character": "a\u0000b",
      "overlong selector": "a".repeat(LIMITS.maxSelector + 1),
    };
    for (const [name, sel] of Object.entries(selectorCases)) {
      test(`selector: ${name}`, () => {
        const d = minimal();
        d.rules[0].locators[0].selector = sel;
        expect(validateRules(d).ok).toBe(false);
      });
    }
    test("text locator match text with code", () => {
      const d = minimal();
      d.rules[0].locators[0] = { type: "text", container: "a", label: "b", match: "() => steal()" };
      expect(validateRules(d).ok).toBe(false);
    });
    test("no false positives on ordinary selectors", () => {
      for (const sel of ["#self .x", ".foo-chrome .x", "a[href*=\"data:\"]", "ytd-browse[page-subtype=\"home\"] ytd-rich-grid-renderer", "body ytd-x", "html .y"]) {
        const d = minimal();
        d.rules[0].locators[0].selector = sel;
        expect(validateRules(d).errors, sel).toEqual([]);
      }
    });
    test("looksLikeCode leaves plain labels alone", () => {
      for (const s of ["Shorts", "Shorts in search results", "Entire Home feed", "End-screen recommendations"]) expect(looksLikeCode(s)).toBe(false);
    });
  });

  test("parseRulesText: rejects invalid JSON and oversized bodies", () => {
    expect(parseRulesText("{nope").errors[0]).toMatch(/not valid JSON/);
    expect(parseRulesText(" ".repeat(LIMITS.maxBytes + 1)).errors[0]).toMatch(/larger than/);
    expect(parseRulesText(JSON.stringify(minimal())).ok).toBe(true);
  });

  test("rules URL must be https", () => {
    expect(validateRulesUrl("https://rules.example.com/neat/rules.json").ok).toBe(true);
    for (const bad of ["http://rules.example.com/r.json", "ftp://x/r.json", "javascript:alert(1)", "data:application/json,{}", "file:///c:/r.json", "//x/r.json", "not a url", "https://user:pw@x.com/r.json"]) {
      expect(validateRulesUrl(bad).ok, bad).toBe(false);
    }
  });

  test("placeholder rules host is recognised and never treated as configured", () => {
    expect(isPlaceholderUrl("https://RULES_HOST/neat-youtube/rules.json")).toBe(true);
    expect(isPlaceholderUrl("https://rules.example.com/r.json")).toBe(false);
  });
});
