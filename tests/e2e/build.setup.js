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
    env: { ...process.env, RULES_URL: "" },
  });
});
