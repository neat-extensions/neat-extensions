import { test, expect } from "@playwright/test";
import { compareVersions, isNewer, parseVersion, ENGINE_VERSION } from "../../packages/engine/src/version.js";

test.describe("version comparison", () => {
  test("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.9.9", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.10", "1.0.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("isNewer is strict", () => {
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("0.9.0", "1.0.0")).toBe(false);
    expect(isNewer("garbage", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", undefined)).toBe(true);
  });

  test("rejects malformed versions", () => {
    for (const v of ["1.0", "1.0.0.0", "01.0.0", "1.0.0-beta", "v1.0.0", " 1.0.0", "", null, 1, "1.0.9999999"]) {
      expect(parseVersion(v), String(v)).toBeNull();
    }
    expect(() => compareVersions("1.0", "1.0.0")).toThrow(/Invalid version/);
  });

  test("engine version is itself valid", () => {
    expect(parseVersion(ENGINE_VERSION)).not.toBeNull();
  });
});
