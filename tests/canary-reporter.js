// Playwright reporter that writes a small summary the canary workflow turns into
// a GitHub issue: which site, which rule ids failed, which tests, which screenshots.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export default class CanaryReporter {
  constructor(options = {}) {
    this.outputFile = options.outputFile || "test-results/canary-summary.json";
    this.failed = [];
    this.blocked = [];
    this.passed = 0;
  }

  onTestEnd(test, result) {
    if (test.parent.project()?.name !== "e2e") return;
    // Passed and skipped results are never retried, so they are final whatever the retry count.
    const final = result.status === "passed" || result.status === "skipped" || result.retry === test.retries;
    if (!final) return;
    if (result.status === "passed") {
      this.passed++;
      return;
    }
    if (result.status === "skipped") {
      // Skipped because YouTube blocked the runner (see helpers.js BLOCKED): could not be judged.
      const why = result.annotations?.find((a) => a.type === "youtube-blocked") || test.annotations.find((a) => a.type === "youtube-blocked");
      if (why) this.blocked.push({ title: test.titlePath().slice(1).join(" › "), reason: why.description });
      return;
    }
    this.failed.push({
      title: test.titlePath().slice(1).join(" › "),
      rules: test.annotations.filter((a) => a.type === "rule").map((a) => a.description),
      // eslint-disable-next-line no-control-regex -- strip ANSI colour codes
      error: (result.error?.message || "").replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 4).join(" ").slice(0, 400),
      screenshots: result.attachments.filter((a) => a.contentType === "image/png" && a.path).map((a) => a.path),
    });
  }

  onEnd() {
    const rules = [...new Set(this.failed.flatMap((f) => f.rules))].sort();
    const summary = { site: "youtube", ok: this.failed.length === 0, passed: this.passed, failedRules: rules, failedTests: this.failed, blocked: this.blocked };
    mkdirSync(path.dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, JSON.stringify(summary, null, 2));
  }

  printsToStdio() {
    return false;
  }
}
