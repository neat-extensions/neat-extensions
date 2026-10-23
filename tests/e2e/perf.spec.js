// Performance budget: total JavaScript time attributable to the extension on
// YouTube Home over 30 seconds (load + scrolling) must stay under 150 ms.
// Measured with the V8 sampling profiler: a sample counts if ANY frame on its
// stack belongs to the extension, so native DOM calls it makes are included.
import { test, expect, URLS, handleConsent, warmUpHome } from "./helpers.js";
import { writeFileSync } from "node:fs";
import path from "node:path";

const BUDGET_MS = 150;
const WINDOW_MS = 30_000;

test("engine scripting time on Home over 30 s stays under 150 ms", async ({ page, extensionId }) => {
  test.setTimeout(180_000);
  await warmUpHome(page); // so Home shows a real feed, not the empty first-visit page
  // Same-origin hop so the profiler is attached to the renderer that loads Home.
  await page.goto("https://www.youtube.com/robots.txt");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); // µs
  await cdp.send("Profiler.start");

  const t0 = Date.now();
  await page.goto(URLS.home, { waitUntil: "domcontentloaded" });
  await handleConsent(page);
  await page.waitForSelector("ytd-browse[page-subtype='home']", { state: "attached" });
  // Typical use: browse around Home, open and close the guide, scroll.
  while (Date.now() - t0 < WINDOW_MS - 1000) {
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(Math.max(0, WINDOW_MS - (Date.now() - t0)));
  const { profile } = await cdp.send("Profiler.stop");

  const prefix = `chrome-extension://${extensionId}/`;
  const parent = new Map();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const memo = new Map();
  const isExt = (id) => {
    if (memo.has(id)) return memo.get(id);
    const n = byId.get(id);
    const v = !!n && (n.callFrame.url.startsWith(prefix) || (parent.has(id) && isExt(parent.get(id))));
    memo.set(id, v);
    return v;
  };
  let extUs = 0;
  let totalUs = 0;
  profile.samples.forEach((id, i) => {
    const dt = profile.timeDeltas[i] || 0;
    totalUs += dt;
    if (isExt(id)) extUs += dt;
  });
  const extMs = extUs / 1000;
  const result = { extensionScriptingMs: Number(extMs.toFixed(2)), profiledMs: Math.round(totalUs / 1000), budgetMs: BUDGET_MS, samples: profile.samples.length };
  writeFileSync(path.join("test-results", "perf.json"), JSON.stringify(result, null, 2));
  test.info().annotations.push({ type: "perf", description: JSON.stringify(result) });
  console.log(`  engine scripting time on Home over 30 s: ${result.extensionScriptingMs} ms (budget ${BUDGET_MS} ms)`);

  // Sanity: the profile must actually contain the extension, or the number means nothing.
  expect(profile.nodes.some((n) => n.callFrame.url.startsWith(prefix)), "extension frames present in profile").toBe(true);
  expect(extMs).toBeLessThan(BUDGET_MS);
});
