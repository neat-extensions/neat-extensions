// Renders apps/<site>/assets/icon.svg to PNG icons with Playwright's Chromium.
// 16/32/48 fill the canvas (toolbar); 128 keeps 16px transparent padding as the
// Chrome Web Store asks (96x96 artwork inside a 128x128 canvas).
import { chromium } from "@playwright/test";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const site = process.argv[2] || "youtube";
const root = path.resolve(import.meta.dirname, "..", "apps", site);
const svg = await readFile(path.join(root, "assets", "icon.svg"), "utf8");
const outDir = path.join(root, "icons");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  const pad = size === 128 ? 16 : 0;
  await page.setViewportSize({ width: size, height: size });
  const dataUrl = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${dataUrl}" style="display:block;width:${size - pad * 2}px;height:${size - pad * 2}px;margin:${pad}px"></body></html>`,
  );
  await page.waitForFunction(() => document.images[0].complete);
  await page.screenshot({ path: path.join(outDir, `icon-${size}.png`), omitBackground: true });
}
await browser.close();
console.log(`icons written to ${outDir}`);
