// Build pipeline: lint → unit tests → bundle → policy checks → zip [→ e2e with --e2e].
// Any failure exits non-zero and no zip is written.
//
//   node scripts/build.mjs [site] [--e2e] [--release] [--skip-tests] [--out <dir>]
//   RULES_URL=https://example.com/rules.json RULES_PUBLIC_KEY='{"kty":"EC",…}' node scripts/build.mjs --release
//   --release refuses placeholders (store uploads must be able to receive rule fixes).
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import { BRAND, BRAND_SLUG } from "../brand.config.js";
import { validateRules, validateRulesUrl, isPlaceholderUrl } from "../packages/engine/src/schema.js";
import { isPublicJwk } from "../packages/engine/src/signature.js";
import { TRUST_LINES } from "../packages/engine/src/trust.js";
import { ALLOWED_PERMISSIONS, MAX_BUNDLE_BYTES, checkManifest, scanSource, checkBundleSize } from "./policy.mjs";
const ROOT = path.resolve(import.meta.dirname, "..");

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const siteName = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out") || "youtube";
const outRoot = path.resolve(ROOT, opt("--out") || "dist");

function step(name) {
  console.log(`\n▶ ${name}`);
}
function fail(msg) {
  console.error(`\n✖ BUILD FAILED: ${msg}`);
  process.exit(1);
}
function run(cmd, cmdArgs, env = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, ...env } });
  return r.status === 0;
}

const appDir = path.join(ROOT, "apps", siteName);
// Tool products (no rules, no updater) have their own pipeline with the same gates.
if ((await stat(path.join(appDir, "app.config.js")).catch(() => null)) !== null) {
  const { buildTool } = await import("./build-tool.mjs");
  await buildTool(siteName, args);
  process.exit(0);
}
const { default: site } = await import(pathToUrl(path.join(appDir, "site.config.js")));
const listing = await import(pathToUrl(path.join(appDir, "listing.js")));
const rules = JSON.parse(await readFile(path.join(appDir, "rules", "rules.json"), "utf8"));
const rulesUrl = process.env.RULES_URL || site.rulesUrl;
const publicKey = process.env.RULES_PUBLIC_KEY ? JSON.parse(process.env.RULES_PUBLIC_KEY) : site.rulesPublicKey;
const outDir = path.join(outRoot, siteName);
const zipName = `${BRAND_SLUG}-${siteName}-${site.version}.zip`;

function pathToUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}

// ---------------------------------------------------------------- lint + unit
if (!flag("--skip-tests")) {
  step("Lint");
  if (!run("npx", ["eslint", "."])) fail("lint errors");
  step("Unit tests");
  if (!run("npx", ["playwright", "test", "--project=unit"])) fail("unit tests failed");
}

// ---------------------------------------------------------------- pre-checks
step("Validate config, rules and listing");
const rv = validateRules(rules, { site: site.id });
if (!rv.ok) fail(`bundled rules invalid:\n  ${rv.errors.join("\n  ")}`);
const uv = validateRulesUrl(rulesUrl);
if (!uv.ok) fail(`RULES_URL: ${uv.error}`);
if (publicKey && !isPublicJwk(publicKey)) fail("rules public key must be a P-256 public JWK (no private part)");
const remoteOn = !isPlaceholderUrl(rulesUrl) && isPublicJwk(publicKey);
if (!remoteOn) console.log("  ⚠ remote rules are OFF in this build (placeholder RULES_URL or no signing key): bundled rules only");
if (flag("--release")) {
  // A store upload must be able to receive rule fixes; refuse to ship a build that can't.
  if (isPlaceholderUrl(rulesUrl)) fail("release build still uses the placeholder RULES_URL — set RULES_URL=https://…");
  if (!isPublicJwk(publicKey)) fail("release build has no rules signing key — run scripts/rules-key.mjs generate and set RULES_PUBLIC_KEY");
}
if (listing.title.length > 45) fail(`listing title is ${listing.title.length} chars (max 45)`);
if (listing.summary.length > 132) fail(`summary is ${listing.summary.length} chars (max 132)`);

// ---------------------------------------------------------------- bundle
step(`Bundle ${site.productName} → ${path.relative(ROOT, outDir)}`);
await rm(outDir, { recursive: true, force: true });
await rm(path.join(outRoot, zipName), { force: true }); // never leave a stale zip behind a failed build
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: ["content", "background", "popup", "options"].map((n) => ({ in: path.join(appDir, "src", `${n}.js`), out: n })),
  outdir: outDir,
  bundle: true,
  format: "iife",
  target: "chrome121",
  minify: false, // readable code for store review
  legalComments: "none",
  charset: "utf8",
  define: { "process.env.RULES_URL": JSON.stringify(rulesUrl), "process.env.RULES_PUBLIC_KEY": JSON.stringify(publicKey ? JSON.stringify(publicKey) : "") },
  logLevel: "warning",
});

const connectSrc = remoteOn ? uv.url.origin : "'none'";
const manifest = {
  manifest_version: 3,
  name: listing.title,
  short_name: BRAND,
  version: site.version,
  description: listing.summary,
  minimum_chrome_version: "121",
  icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
  action: {
    default_title: site.productName,
    default_popup: "popup.html",
    default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" },
  },
  options_ui: { page: "options.html", open_in_tab: true },
  background: { service_worker: "background.js" },
  content_scripts: [{ matches: site.matches, js: ["content.js"], run_at: "document_start", all_frames: false }],
  permissions: [...ALLOWED_PERMISSIONS],
  host_permissions: site.hostPermissions,
  commands: {
    [site.masterCommand.id]: { suggested_key: { default: site.masterCommand.key }, description: `Turn ${BRAND} on or off` },
  },
  content_security_policy: {
    extension_pages: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src ${connectSrc}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  },
};
await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const fill = (html) =>
  html
    .replaceAll("{{PRODUCT}}", site.productName)
    .replaceAll("{{BRAND}}", BRAND)
    .replaceAll("{{TRUST_ITEMS}}", TRUST_LINES.map((t) => `<li>${t}</li>`).join(""));
for (const page of ["popup.html", "options.html"]) {
  const html = await readFile(path.join(ROOT, "packages", "engine", "ui", page), "utf8");
  const out = fill(html);
  if (/\{\{[A-Z_]+\}\}/.test(out)) fail(`${page} has an unfilled placeholder`);
  await writeFile(path.join(outDir, page), out);
}
await cp(path.join(ROOT, "packages", "engine", "ui", "ui.css"), path.join(outDir, "ui.css"));
await cp(path.join(appDir, "icons"), path.join(outDir, "icons"), { recursive: true });

// ---------------------------------------------------------------- policy checks
step("Policy checks");
const built = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
const manifestErrors = checkManifest(built);
if (manifestErrors.length) fail(manifestErrors.join("; "));

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}
const files = await walk(outDir);
let total = 0;
for (const f of files) total += (await stat(f)).size;
console.log(`  bundle size: ${(total / 1024).toFixed(1)} KB across ${files.length} files (limit ${MAX_BUNDLE_BYTES / 1024} KB)`);
const sizeErrors = checkBundleSize(total);
if (sizeErrors.length) fail(sizeErrors[0]);

// No remote code, dynamic code, HTML injection or unexpected hosts in shipped JavaScript.
for (const f of files.filter((x) => x.endsWith(".js"))) {
  // site.config.js is bundled whole, so its default rulesUrl is present even when RULES_URL overrides it.
  const problems = scanSource(await readFile(f, "utf8"), [rulesUrl, site.rulesUrl]);
  if (problems.length) fail(`${path.relative(ROOT, f)} ${problems.join("; ")}`);
}
console.log(`  permissions: ${JSON.stringify(built.permissions)}  host_permissions: ${JSON.stringify(built.host_permissions)}`);

// ---------------------------------------------------------------- zip
step("Zip");
const entries = {};
for (const f of files) entries[path.relative(outDir, f).replace(/\\/g, "/")] = new Uint8Array(await readFile(f));
const zipPath = path.join(outRoot, zipName);
await writeFile(zipPath, zipSync(entries, { level: 9, mtime: new Date("2026-01-01T00:00:00Z") }));
console.log(`  wrote ${path.relative(ROOT, zipPath)} (${((await stat(zipPath)).size / 1024).toFixed(1)} KB)`);

// ---------------------------------------------------------------- e2e (optional)
if (flag("--e2e")) {
  step("End-to-end tests (live YouTube)");
  if (!run("npx", ["playwright", "test", "--project=e2e"])) {
    await rm(zipPath, { force: true });
    fail("e2e tests failed (zip removed)");
  }
}
console.log(`\n✔ ${BRAND} for ${site.name} ${site.version} built.`);
