// Builds the e2e copy of Neat Record into dist-test/record (never the release
// zip): time-scaled free limit, a stub Drive token pointed at a local fake
// Drive, and a throwaway licence key pair so tests never touch the real one.
import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { generateLicenceKeyPair } from "../../scripts/licence-sign.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

test("build Neat Record for e2e", async () => {
  const { privateJwk, publicJwk } = await generateLicenceKeyPair();
  mkdirSync(path.join(ROOT, "dist-test"), { recursive: true });
  writeFileSync(path.join(ROOT, "dist-test", "record-licence-test.jwk"), JSON.stringify(privateJwk));
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), "record", "--skip-tests", "--test", "--out", "dist-test"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, RECORD_LICENCE_PUBLIC_KEY: JSON.stringify(publicJwk) },
  });
});
