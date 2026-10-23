// Builds the unpacked extension into dist-test/ before any e2e test runs.
// (A separate folder so an e2e run never touches the release zip in dist/.)
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("build unpacked extension for e2e", () => {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), "--skip-tests", "--out", "dist-test"], {
    cwd: ROOT,
    stdio: "inherit",
    // Same rules URL + key as the shipped build (site.config.js) unless E2E_RULES_URL / E2E_RULES_PUBLIC_KEY override them.
    env: { ...process.env, RULES_URL: process.env.E2E_RULES_URL || "", RULES_PUBLIC_KEY: process.env.E2E_RULES_PUBLIC_KEY || "" },
  });
});
