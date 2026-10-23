import { test, expect } from "@playwright/test";
import { publish, status, CwsError } from "../../scripts/cws.mjs";
import site from "../../apps/youtube/site.config.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";

test.describe("Chrome Web Store client", () => {
  test("publish refuses unless explicitly confirmed with --publish (before any credential or network use)", async () => {
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("no network in this test");
    };
    try {
      for (const opts of [undefined, {}, { confirmed: false }, { confirmed: "yes" }, { confirmed: 1 }]) {
        await expect(publish(ID, opts)).rejects.toThrow(/refusing to publish without --publish/);
      }
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  test("item ids are validated before any request", async () => {
    for (const bad of ["", "hepcnbecbgcoehobgflnlfmebelkh", "ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", `${ID}x`, "../../publishers"]) {
      await expect(status(bad)).rejects.toThrow(CwsError);
      await expect(status(bad)).rejects.toThrow(/32-letter/);
    }
  });

  test("site storeItemId is unset or a valid 32-letter id", () => {
    expect(site.storeItemId === null || /^[a-p]{32}$/.test(site.storeItemId)).toBe(true);
  });
});
