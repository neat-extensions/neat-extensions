// Ship a release to the Chrome Web Store: full release pipeline (lint, unit, build,
// policy, zip, live e2e) → upload the zip to the existing store item → print status.
// Submits for review ONLY with --publish.
//
//   npm run release:ship [-- <site>] [-- --publish]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BRAND_SLUG } from "../brand.config.js";
import { status, upload, publish, CwsError } from "./cws.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const siteName = args.find((a) => !a.startsWith("--")) || "youtube";
const { default: site } = await import(new URL(`file:///${path.join(ROOT, "apps", siteName, "site.config.js").replace(/\\/g, "/")}`).href);

try {
  if (!site.storeItemId) throw new CwsError(`apps/${siteName}/site.config.js has no storeItemId`);
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), siteName, "--release", "--e2e"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new CwsError("release pipeline failed — nothing uploaded");
  const zip = path.join(ROOT, "dist", `${BRAND_SLUG}-${siteName}-${site.version}.zip`);
  console.log(`\n▶ Upload ${path.relative(ROOT, zip)} → store item ${site.storeItemId} (draft; not published)`);
  console.log(JSON.stringify(await upload(site.storeItemId, zip), null, 2));
  console.log("\n▶ Store status");
  console.log(JSON.stringify(await status(site.storeItemId), null, 2));
  if (args.includes("--publish")) {
    console.log("\n▶ Submit for review (--publish)");
    console.log(JSON.stringify(await publish(site.storeItemId, { confirmed: true }), null, 2));
  } else {
    console.log("\nUploaded as a draft. Not submitted — re-run with --publish to submit for review.");
  }
} catch (e) {
  console.error(`✖ release:ship: ${e.message}`);
  process.exitCode = 1;
}
