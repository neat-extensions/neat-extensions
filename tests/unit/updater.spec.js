import { test, expect } from "@playwright/test";
import { createUpdater, MIN_REFETCH_MS } from "../../packages/engine/src/updater.js";
import { pickRules } from "../../packages/engine/src/settings.js";

const URL_OK = "https://rules.example.com/neat-youtube/rules.json";
const doc = (version, extra = {}) => ({
  version,
  site: "youtube",
  minEngineVersion: "1.0.0",
  rules: [{ id: "a", label: "A", default: true, group: "G", locators: [{ type: "css", selector: "div.x" }] }],
  ...extra,
});
const bundled = doc("1.0.0");

function fakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
  };
}
function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (body instanceof Error) throw body;
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}
const make = (fetchImpl, storage = fakeStorage(), rulesUrl = URL_OK, now = () => 1_000_000_000) =>
  ({ storage, u: createUpdater({ site: "youtube", bundled, rulesUrl, storage, fetchImpl, now }) });

test.describe("remote rules updater", () => {
  test("stores a newer valid rules file", async () => {
    const f = fakeFetch(doc("1.1.0"));
    const { u, storage } = make(f);
    expect((await u.refresh("install")).updated).toBe(true);
    expect(storage.data.rules.version).toBe("1.1.0");
    expect(f.calls[0].url).toBe(URL_OK);
    expect(f.calls[0].init.credentials).toBe("omit");
  });

  test("ignores same or older versions", async () => {
    for (const v of ["1.0.0", "0.9.0"]) {
      const { u, storage } = make(fakeFetch(doc(v)));
      expect((await u.refresh("install")).updated).toBe(false);
      expect(storage.data.rules).toBeUndefined();
    }
  });

  test("keeps the last good rules when validation fails", async () => {
    const storage = fakeStorage({ rules: doc("1.1.0") });
    const { u } = make(fakeFetch(doc("2.0.0", { evil: "x" })), storage);
    const r = await u.refresh("install");
    expect(r.updated).toBe(false);
    expect(r.status).toMatch(/rejected: root: unknown key "evil"/);
    expect(storage.data.rules.version).toBe("1.1.0");
  });

  test("rejects rules for another site", async () => {
    const { u, storage } = make(fakeFetch({ ...doc("2.0.0"), site: "reddit" }));
    expect((await u.refresh("install")).status).toMatch(/site/);
    expect(storage.data.rules).toBeUndefined();
  });

  test("keeps the last good rules on network and HTTP errors", async () => {
    for (const f of [fakeFetch(new TypeError("Failed to fetch")), fakeFetch("x", { status: 500 }), fakeFetch("{not json")]) {
      const storage = fakeStorage({ rules: doc("1.1.0") });
      const { u } = make(f, storage);
      expect((await u.refresh("install")).updated).toBe(false);
      expect(storage.data.rules.version).toBe("1.1.0");
      expect(storage.data.rulesMeta.status).toMatch(/fetch failed|rejected/);
    }
  });

  test("never fetches the placeholder or a non-https URL", async () => {
    for (const url of ["https://RULES_HOST/neat-youtube/rules.json", "http://rules.example.com/r.json"]) {
      const f = fakeFetch(doc("9.0.0"));
      const { u } = make(f, fakeStorage(), url);
      expect(u.configured).toBe(false);
      await u.refresh("install");
      expect(f.calls.length).toBe(0);
    }
  });

  test("throttles scheduled refreshes; a manual check bypasses the throttle", async () => {
    let t = 10_000_000;
    const f = fakeFetch(doc("1.0.0"));
    const { u } = make(f, fakeStorage(), URL_OK, () => t);
    await u.refresh("startup");
    t += 1000;
    expect((await u.refresh("alarm")).status).toBe("throttled");
    await u.refresh("manual");
    t += MIN_REFETCH_MS + 1;
    await u.refresh("alarm");
    expect(f.calls.length).toBe(3);
  });

  test("coalesces concurrent refreshes into one request", async () => {
    const f = fakeFetch(doc("1.2.0"));
    const { u } = make(f);
    await Promise.all([u.refresh("install"), u.refresh("recheck"), u.refresh("recheck")]);
    expect(f.calls.length).toBe(1);
  });

  test("pickRules prefers newer valid stored rules, else bundled", () => {
    expect(pickRules(bundled, doc("1.1.0"), "youtube").source).toBe("remote");
    expect(pickRules(bundled, doc("0.1.0"), "youtube").source).toBe("bundled");
    expect(pickRules(bundled, { ...doc("9.0.0"), x: 1 }, "youtube").source).toBe("bundled");
    expect(pickRules(bundled, { ...doc("9.0.0"), site: "reddit" }, "youtube").source).toBe("bundled");
    expect(pickRules(bundled, null, "youtube").source).toBe("bundled");
  });
});
