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
    expect(normalizeChannel("@हिंदी")).toBe("@हिंदी"); // combining marks
    expect(normalizeChannel("@caféx")).toBe("@caféx"); // NFC
    expect(normalizeChannel("https://www.youtube.com/@%E5%90%8D%E5%89%8D%E3%81%A1%E3%82%83%E3%82%93")).toBe("@名前ちゃん");
    for (const bad of [
      "", "   ", "@a", "https://evil.com/@x", "<img src=x>", "@has space", null,
      "https://www.youtube.com/watch?v=jNQXAC9IVRw", "https://www.youtube.com/user/LinusTechTips", "https://www.youtube.com/c/LinusTechTips",
      "https://www.youtube.com/shorts/Y8IJi7iP5vk", "https://www.youtube.com/feed/subscriptions", "youtube.com/results?search_query=x", "a/b",
    ]) expect(normalizeChannel(bad), String(bad)).toBeNull();
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

  test("pageContext reads the channel from the URL, and the UC id from the canonical link on /c/ and /user/ pages", () => {
    const canon = (href) => ({ querySelector: (s) => (s.includes("canonical") ? { getAttribute: () => href } : null) });
    expect(site.pageContext(canon("https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw"), new URL("https://www.youtube.com/user/LinusTechTips")).channel).toEqual({ id: "UCXuqSBlHAE6Xw-yeJA0Tunw" });
    expect(site.pageContext(canon("https://www.youtube.com/channel/UCXuqSBlHAE6Xw-yeJA0Tunw"), new URL("https://www.youtube.com/@LinusTechTips")).channel).toEqual({ handle: "@linustechtips", id: "UCXuqSBlHAE6Xw-yeJA0Tunw" });
    const doc = { querySelector: () => null };
    expect(site.pageContext(doc, new URL("https://www.youtube.com/@LinusTechTips/videos"))).toEqual({ page: "channel", channel: { handle: "@linustechtips" }, pending: false });
    expect(site.pageContext(doc, new URL("https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A"))).toEqual({ page: "channel", channel: { id: "UC4QobU6STFB0P71PMvOGN5A" }, pending: false });
    expect(site.pageContext(doc, new URL("https://www.youtube.com/results?search_query=x")).page).toBe("search");
    expect(site.pageContext(doc, new URL("https://www.youtube.com/")).page).toBe("home");
  });

  const watchDoc = (videoId, owner) => ({
    querySelector: (s) => (s === "ytd-watch-flexy" ? { getAttribute: () => videoId } : s.includes("#owner") ? (owner ? { getAttribute: () => owner } : null) : null),
  });
  const WATCH = new URL("https://www.youtube.com/watch?v=jNQXAC9IVRw");

  test("pageContext trusts the watch-page owner only once the player shows this URL's video", () => {
    expect(site.pageContext(watchDoc("jNQXAC9IVRw", "/@jawed"), WATCH)).toEqual({ page: "watch", channel: { handle: "@jawed" }, pending: false });
    // after an in-app navigation the old owner is still in the DOM: not trusted
    expect(site.pageContext(watchDoc("PREVIOUSvid", "/@jawed"), WATCH)).toEqual({ page: "watch", channel: null, pending: true });
    expect(site.pageContext(watchDoc("jNQXAC9IVRw", null), WATCH)).toMatchObject({ channel: null, pending: true });
  });

  test("isAllowed matches by handle or id, including learned id-handle aliases", () => {
    const ctx = site.pageContext(watchDoc("jNQXAC9IVRw", "/@jawed"), WATCH);
    const S = (allowlist, aliases = {}) => ({ allowlist, aliases });
    expect(site.isAllowed(S(["@jawed"]), ctx)).toBe(true);
    expect(site.isAllowed(S(["@someoneelse"]), ctx)).toBe(false);
    expect(site.isAllowed(S(["UC4QobU6STFB0P71PMvOGN5A"]), ctx)).toBe(false);
    expect(site.isAllowed(S(["UC4QobU6STFB0P71PMvOGN5A"], { UC4QobU6STFB0P71PMvOGN5A: "@jawed" }), ctx)).toBe(true);
    expect(site.isAllowed(S(["@jawed"]), { page: "home", channel: null })).toBe(false);
    const chan = { page: "channel", channel: { id: "UC4QobU6STFB0P71PMvOGN5A" } };
    expect(site.isAllowed(S(["@jawed"], { UC4QobU6STFB0P71PMvOGN5A: "@jawed" }), chan)).toBe(true);
  });

  test("every hiding rule has an independent self-check probe", async () => {
    const { readFileSync } = await import("node:fs");
    const rules = JSON.parse(readFileSync(new URL("../../apps/youtube/rules/rules.json", import.meta.url), "utf8"));
    for (const r of rules.rules) expect(site.probes[r.id], r.id).toBeTruthy();
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
