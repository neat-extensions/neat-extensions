import { test, expect } from "@playwright/test";
import site, { normalizeChannel } from "../../apps/youtube/site.config.js";
import { watchUrlFor } from "../../apps/youtube/src/features.js";
import * as listing from "../../apps/youtube/listing.js";
import { BRAND } from "../../brand.config.js";

test.describe("YouTube site config", () => {
  test("normalizes allow-list input", () => {
    expect(normalizeChannel("@LinusTechTips")).toBe("@linustechtips");
    expect(normalizeChannel("LinusTechTips")).toBe("@linustechtips");
    expect(normalizeChannel(" https://www.youtube.com/@LinusTechTips/videos ")).toBe("@linustechtips");
    expect(normalizeChannel("youtube.com/@jawed")).toBe("@jawed");
    expect(normalizeChannel("https://m.youtube.com/@jawed")).toBe("@jawed");
    expect(normalizeChannel("https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A")).toBe("UC4QobU6STFB0P71PMvOGN5A");
    expect(normalizeChannel("UC4QobU6STFB0P71PMvOGN5A")).toBe("UC4QobU6STFB0P71PMvOGN5A");
    expect(normalizeChannel("@名前チャンネル")).toBe("@名前チャンネル");
    for (const bad of ["", "   ", "@a", "https://evil.com/@x", "<img src=x>", "@has space", null]) expect(normalizeChannel(bad), String(bad)).toBeNull();
  });

  test("maps /shorts/ID to /watch?v=ID and nothing else", () => {
    expect(watchUrlFor("/shorts/Y8IJi7iP5vk")).toBe("/watch?v=Y8IJi7iP5vk");
    expect(watchUrlFor("/shorts/Y8IJi7iP5vk/")).toBe("/watch?v=Y8IJi7iP5vk");
    expect(watchUrlFor("/watch")).toBeNull();
    expect(watchUrlFor("/shorts/")).toBeNull();
    expect(watchUrlFor("/shorts/short")).toBeNull();
    expect(watchUrlFor("/shorts/Y8IJi7iP5vkEXTRA")).toBeNull();
    // the target can never itself be a Shorts URL, so a redirect cannot loop on itself
    expect(watchUrlFor(watchUrlFor("/shorts/Y8IJi7iP5vk"))).toBeNull();
  });

  test("pageContext reads the channel from the URL", () => {
    const doc = { querySelector: () => null };
    expect(site.pageContext(doc, new URL("https://www.youtube.com/@LinusTechTips/videos"))).toEqual({ page: "channel", channel: { handle: "@linustechtips" } });
    expect(site.pageContext(doc, new URL("https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A"))).toEqual({ page: "channel", channel: { id: "UC4QobU6STFB0P71PMvOGN5A" } });
    expect(site.pageContext(doc, new URL("https://www.youtube.com/results?search_query=x")).page).toBe("search");
    expect(site.pageContext(doc, new URL("https://www.youtube.com/")).page).toBe("home");
  });

  test("pageContext reads the owner on watch pages, and isAllowed matches it", () => {
    const doc = { querySelector: () => ({ getAttribute: () => "/@jawed" }) };
    const ctx = site.pageContext(doc, new URL("https://www.youtube.com/watch?v=jNQXAC9IVRw"));
    expect(ctx).toEqual({ page: "watch", channel: { handle: "@jawed" } });
    expect(site.isAllowed(["@jawed"], ctx)).toBe(true);
    expect(site.isAllowed(["@someoneelse"], ctx)).toBe(false);
    expect(site.isAllowed(["@jawed"], { page: "home", channel: null })).toBe(false);
  });

  test("listing copy fits store limits and leads with the required line", () => {
    expect(listing.title).toBe(`${BRAND} — Hide YouTube Shorts`);
    expect(listing.title.length).toBeLessThanOrEqual(45);
    expect(listing.summary.length).toBeLessThanOrEqual(132);
    expect(listing.description.split("\n")[0]).toBe("Shorts gone. YouTube back to videos.");
    for (const line of ["No account.", "Nothing leaves your browser.", "Open source."]) expect(listing.description).toContain(line);
  });

  test("every feature has a unique id that no rule uses", async () => {
    const { readFileSync } = await import("node:fs");
    const rules = JSON.parse(readFileSync(new URL("../../apps/youtube/rules/rules.json", import.meta.url), "utf8"));
    const ids = [...rules.rules.map((r) => r.id), ...site.features.map((f) => f.id)];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
