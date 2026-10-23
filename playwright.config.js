import { defineConfig } from "@playwright/test";

const CI = !!process.env.CI;

export default defineConfig({
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: CI,
  outputDir: "test-results/artifacts",
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/results.json" }],
    ["./tests/canary-reporter.js", { outputFile: "test-results/canary-summary.json" }],
  ],
  projects: [
    { name: "unit", testDir: "tests/unit", timeout: 30_000, workers: 4 },
    { name: "build-ext", testDir: "tests/e2e", testMatch: /build\.setup\.js/ },
    {
      name: "e2e",
      testDir: "tests/e2e",
      testIgnore: /build\.setup\.js/,
      dependencies: ["build-ext"],
      workers: 1, // one real browser at a time: live YouTube, stable timings
      retries: CI ? 1 : 0,
      use: { screenshot: "only-on-failure", trace: CI ? "retain-on-failure" : "off" },
    },
  ],
});
