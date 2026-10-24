// Build pipeline for tool products (apps/<app>/app.config.js with kind "tool"),
// e.g. Neat Record: lint → unit tests → bundle → policy checks → zip.
// Same gates as the rules products, with the product's own policy profile.
// No remote rules, no updater.
//
//   node scripts/build.mjs record [--release] [--skip-tests] [--out <dir>] [--test]
//   --test     e2e build: time-scaled free limit, stub Drive token, local fake Drive (dist-test only)
//   --release  refuses placeholders (OAuth client, Payment Link) and any test setting
//
// Output: <out>/<app>/ (unpacked, with the manifest "key" so the ID is pinned) and
// <out>/<brand>-<app>-<version>.zip (store package: the same files, manifest without "key",
// because the Chrome Web Store gives a new item its own key on first upload).
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import { BRAND, BRAND_SLUG } from "../brand.config.js";
import { RECORD_POLICY, checkToolManifest, scanSource, checkBundleSize } from "./policy.mjs";
import { extensionIdFromKey } from "./extension-key.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const POLICIES = { record: RECORD_POLICY };

export async function buildTool(appName, args) {
  const flag = (f) => args.includes(f);
  const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  const outRoot = path.resolve(ROOT, opt("--out") || "dist");
  const step = (name) => console.log(`\n▶ ${name}`);
  const fail = (msg) => {
    console.error(`\n✖ BUILD FAILED: ${msg}`);
    process.exit(1);
  };
  const run = (cmd, a) => spawnSync(cmd, a, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" }).status === 0;
  const url = (p) => new URL(`file:///${p.replace(/\\/g, "/")}`).href;

  const appDir = path.join(ROOT, "apps", appName);
  const { default: app } = await import(url(path.join(appDir, "app.config.js")));
  const listing = await import(url(path.join(appDir, "listing.js")));
  const policy = POLICIES[appName];
  if (!policy) fail(`no policy profile for ${appName} in scripts/policy.mjs`);
  const outDir = path.join(outRoot, appName);
  const oauthPlaceholder = /^OAUTH_CLIENT_ID/.test(app.oauthClientId);
  const buyPlaceholder = /PAYMENT_LINK/.test(app.buyUrl);
  // Only a build with the real OAuth client and Payment Link gets the store file name;
  // anything else is clearly marked so it can't be uploaded by mistake.
  const zipName = `${BRAND_SLUG}-${appName}-${app.version}${oauthPlaceholder || buyPlaceholder || flag("--test") ? "-not-for-upload" : ""}.zip`;

  // Test-only settings. Release and normal builds always use the shipped values.
  const test = flag("--test");
  const TEST_DRIVE = "http://127.0.0.1:47123";
  const env = {
    RECORD_TIME_SCALE: test ? process.env.RECORD_TIME_SCALE || "30" : "1",
    RECORD_TEST_TOKEN: test ? "test-token" : "",
    RECORD_DRIVE_BASE: test ? TEST_DRIVE : "https://www.googleapis.com",
    // Web sign-in for browsers without Chrome's own (Edge, Brave): tests use a fake Google on 127.0.0.1.
    RECORD_AUTH_URL: test ? `${TEST_DRIVE}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
    RECORD_WEB_CLIENT_ID: test ? "test-web-client.apps.googleusercontent.com" : app.oauthWebClientId,
    // A throwaway licence key pair made by the e2e setup, so tests never need the real private key.
    RECORD_LICENCE_PUBLIC_KEY: test ? process.env.RECORD_LICENCE_PUBLIC_KEY || "" : "",
    RECORD_SHADOW: test ? "open" : "closed",
  };
  const TEST_HOSTS = ["http://127.0.0.1/*"]; // e2e only: tests can't click the toolbar button, which is what grants activeTab
  if (test && flag("--release")) fail("--test and --release cannot be combined");

  if (!flag("--skip-tests")) {
    step("Lint");
    if (!run("npx", ["eslint", "."])) fail("lint errors");
    step("Unit tests");
    if (!run("npx", ["playwright", "test", "--project=unit"])) fail("unit tests failed");
  }

  step("Validate config and listing");
  if (listing.title.length > 45) fail(`listing title is ${listing.title.length} chars (max 45)`);
  if (listing.summary.length > 132) fail(`summary is ${listing.summary.length} chars (max 132)`);
  if (extensionIdFromKey(app.extensionKey) !== app.extensionId) fail("app.config.js extensionKey does not produce extensionId");
  if (oauthPlaceholder) console.log("  ⚠ OAuth client id is a placeholder: Share to Drive says it is not switched on yet");
  if (buyPlaceholder) console.log("  ⚠ Payment Link is a placeholder: the Pro page shows 'coming soon'");
  if (flag("--release")) {
    if (oauthPlaceholder) fail("release build still has the placeholder OAuth client id (apps/record/app.config.js → oauthClientId)");
    if (buyPlaceholder) fail("release build still has the placeholder Payment Link (apps/record/app.config.js → buyUrl)");
    // The "?" link and the Pro page must exist before anyone can install this.
    for (const f of ["help.html", "pro.html", "privacy.html", "poster.png"]) {
      if (!(await stat(path.join(ROOT, "docs", appName, f)).catch(() => null))) fail(`docs/${appName}/${f} is missing — run npm run store -- ${appName} and push`);
    }
  }

  step(`Bundle ${app.productName} → ${path.relative(ROOT, outDir)}`);
  await rm(outDir, { recursive: true, force: true });
  // Never leave a stale zip of either name behind.
  for (const n of [`${BRAND_SLUG}-${appName}-${app.version}.zip`, `${BRAND_SLUG}-${appName}-${app.version}-not-for-upload.zip`]) await rm(path.join(outRoot, n), { force: true });
  await mkdir(outDir, { recursive: true });
  const entries = ["background", "content", "offscreen", "writer", "popup", "pro", "allow", "camera"];
  await build({
    entryPoints: entries.map((n) => ({ in: path.join(appDir, "src", test && n === "background" ? "test-hook.js" : `${n}.js`), out: n })),
    outdir: outDir,
    bundle: true,
    format: "iife",
    target: "chrome127",
    minify: false, // readable code for store review
    legalComments: "none",
    charset: "utf8",
    define: Object.fromEntries(Object.entries(env).map(([k, v]) => [`process.env.${k}`, JSON.stringify(v)])),
    logLevel: "warning",
  });

  const connect = ["https://www.googleapis.com", ...(test ? [TEST_DRIVE] : [])];
  const manifest = {
    manifest_version: 3,
    name: listing.title,
    short_name: app.productName,
    version: app.version,
    description: listing.summary,
    minimum_chrome_version: "127",
    key: app.extensionKey,
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
    action: { default_title: app.productName, default_popup: "popup.html", default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } },
    background: { service_worker: "background.js" },
    permissions: [...policy.permissions],
    ...(test ? { host_permissions: TEST_HOSTS } : {}),
    web_accessible_resources: policy.war,
    // Every platform named, so the key is assigned at install (Alt = Option on a Mac).
    commands: { [app.command.id]: { suggested_key: { default: app.command.key, windows: app.command.key, mac: app.command.key, linux: app.command.key, chromeos: app.command.key }, description: "Stop recording (anyone) or start one (Pro)" } },
    oauth2: { client_id: app.oauthClientId, scopes: [app.driveScope] },
    // No frame-ancestors: the webcam bubble (camera.html) is shown inside the recorded page. Every
    // other page can't be framed by websites anyway: only camera.html is web-accessible.
    content_security_policy: {
      extension_pages: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; connect-src ${connect.join(" ")}; object-src 'none'; base-uri 'none'; form-action 'none'`,
    },
  };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Pages: fill placeholders, copy styles, write the design tokens, icons.
  const { TOKENS } = await import(url(path.join(appDir, "src", "lib", "tokens.js")));
  await writeFile(path.join(outDir, "tokens.css"), TOKENS.replaceAll(":host, :root", ":root"));
  const uiDir = path.join(appDir, "ui");
  for (const f of await readdir(uiDir)) {
    const src = await readFile(path.join(uiDir, f), "utf8");
    const out = f.endsWith(".html") ? src.replaceAll("{{PRODUCT}}", app.productName).replaceAll("{{BRAND}}", BRAND) : src;
    if (/\{\{[A-Z_]+\}\}/.test(out)) fail(`${f} has an unfilled placeholder`);
    await writeFile(path.join(outDir, f), out);
  }
  await cp(path.join(appDir, "icons"), path.join(outDir, "icons"), { recursive: true });

  step("Policy checks");
  const built = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
  const manifestErrors = checkToolManifest(built, test ? { ...policy, hosts: TEST_HOSTS } : policy, { testConnect: test ? [TEST_DRIVE] : [] });
  if (manifestErrors.length) fail(manifestErrors.join("; "));
  for (const e of entries) if (!(await stat(path.join(outDir, `${e}.js`)).catch(() => null))) fail(`missing ${e}.js`);

  const walk = async (dir) => {
    const out = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  };
  const files = await walk(outDir);
  let total = 0;
  for (const f of files) total += (await stat(f)).size;
  console.log(`  bundle size: ${(total / 1024).toFixed(1)} KB across ${files.length} files (limit ${policy.maxBytes / 1024} KB)`);
  const sizeErrors = checkBundleSize(total, policy.maxBytes);
  if (sizeErrors.length) fail(sizeErrors[0]);
  for (const f of files.filter((x) => x.endsWith(".js"))) {
    const src = await readFile(f, "utf8");
    const problems = scanSource(src, test ? [TEST_DRIVE] : [], policy);
    if (problems.length) fail(`${path.relative(ROOT, f)} ${problems.join("; ")}`);
    if (!test && /test-token|127\.0\.0\.1|neatTest\s*=/.test(src)) fail(`${path.relative(ROOT, f)} contains a test setting`);
  }
  // Every page loads only bundled files.
  for (const f of files.filter((x) => x.endsWith(".html"))) {
    const html = await readFile(f, "utf8");
    if (/<script(?![^>]*\bsrc="[a-z]+\.js")/i.test(html) || /\son[a-z]+=/i.test(html) || /(src|href)="(https?:|\/\/)/i.test(html)) fail(`${path.relative(ROOT, f)} has an inline script, inline handler or remote resource`);
  }
  console.log(`  permissions: ${JSON.stringify(built.permissions)}  host_permissions: ${JSON.stringify(built.host_permissions || [])}  extension id: ${app.extensionId}`);

  step("Zip (store package, manifest without key)");
  const zipEntries = {};
  for (const f of files) {
    const rel = path.relative(outDir, f).replace(/\\/g, "/");
    if (rel === "manifest.json") {
      const storeManifest = { ...built };
      delete storeManifest.key;
      zipEntries[rel] = new TextEncoder().encode(JSON.stringify(storeManifest, null, 2) + "\n");
    } else zipEntries[rel] = new Uint8Array(await readFile(f));
  }
  const zipPath = path.join(outRoot, zipName);
  await writeFile(zipPath, zipSync(zipEntries, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") }));
  console.log(`  wrote ${path.relative(ROOT, zipPath)} (${((await stat(zipPath)).size / 1024).toFixed(1)} KB)`);
  if (flag("--e2e")) {
    step("End-to-end tests (Neat Record, local)");
    if (!run("npx", ["playwright", "test", "--project=record-e2e"])) {
      await rm(zipPath, { force: true });
      fail("e2e tests failed (zip removed)");
    }
  }
  console.log(`\n✔ ${app.productName} ${app.version} built.${test ? " (TEST BUILD — never upload)" : zipName.includes("not-for-upload") ? " (placeholders: zip marked not-for-upload)" : ""}`);
}
