import { test, expect } from "@playwright/test";
import { createUpdater, MIN_REFETCH_MS } from "../../packages/engine/src/updater.js";
import { pickRules } from "../../packages/engine/src/settings.js";
import { generateKeyPair, signBytes } from "../../scripts/rules-key.mjs";

let KEYS_;
let OTHER;
test.beforeAll(async () => {
  KEYS_ = await generateKeyPair();
  OTHER = await generateKeyPair();
});

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
/**
 * Fake rules host. `body` is the rules (object/string/Error); the .sig is made
 * with `signer` (default: the trusted key) unless `sig` overrides it.
 */
function fakeFetch(body, { status = 200, signer, sig, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (body instanceof Error) throw body;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const bytes = new TextEncoder().encode(text);
    let out = bytes;
    if (url.endsWith(".sig")) out = new TextEncoder().encode(sig ?? (await signBytes((signer || KEYS_).privateJwk, bytes)));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
      arrayBuffer: async () => out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength),
    };
  };
  fn.calls = calls;
  fn.rulesCalls = () => calls.filter((c) => !c.url.endsWith(".sig"));
  return fn;
}
const make = (fetchImpl, storage = fakeStorage(), rulesUrl = URL_OK, now = () => 1_000_000_000, publicKey = KEYS_.publicJwk) =>
  ({ storage, u: createUpdater({ site: "youtube", bundled, rulesUrl, publicKey, storage, fetchImpl, now }) });

test.describe("remote rules updater", () => {
  test("stores a newer valid rules file", async () => {
    const f = fakeFetch(doc("1.1.0"));
    const { u, storage } = make(f);
    expect((await u.refresh("install")).updated).toBe(true);
    expect(storage.data.rules.version).toBe("1.1.0");
    expect(f.calls.map((c) => c.url).sort()).toEqual([URL_OK, `${URL_OK}.sig`]);
    expect(f.calls[0].init.credentials).toBe("omit");
    expect(f.calls[0].init.redirect).toBe("error");
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

  test.describe("signature", () => {
    for (const [name, opts] of [
      ["missing/garbage signature", { sig: "not-a-signature" }],
      ["signed by another key", { signer: "OTHER" }],
      ["empty signature", { sig: "" }],
    ]) {
      test(`rejects ${name} and keeps the last good rules`, async () => {
        const storage = fakeStorage({ rules: doc("1.1.0") });
        const f = fakeFetch(doc("2.0.0"), { ...opts, signer: opts.signer === "OTHER" ? OTHER : undefined });
        const { u } = make(f, storage);
        const r = await u.refresh("install");
        expect(r.updated).toBe(false);
        expect(r.status).toMatch(/rejected: signature/);
        expect(storage.data.rules.version).toBe("1.1.0");
      });
    }
    test("rejects a body altered after signing", async () => {
      const good = JSON.stringify(doc("2.0.0"));
      const sig = await signBytes(KEYS_.privateJwk, new TextEncoder().encode(good));
      const { u, storage } = make(fakeFetch(good.replace("div.x", "div.y"), { sig }));
      expect((await u.refresh("install")).status).toMatch(/signature/);
      expect(storage.data.rules).toBeUndefined();
    });
    test("no public key configured = remote rules off, nothing fetched", async () => {
      const f = fakeFetch(doc("9.0.0"));
      const { u } = make(f, fakeStorage(), URL_OK, undefined, null);
      expect(u.configured).toBe(false);
      await u.refresh("install");
      expect(f.calls.length).toBe(0);
    });
    test("refuses oversized responses without reading them", async () => {
      const { u, storage } = make(fakeFetch(doc("2.0.0"), { headers: { "content-length": String(10 * 1024 * 1024) } }));
      expect((await u.refresh("install")).status).toMatch(/larger than/);
      expect(storage.data.rules).toBeUndefined();
    });
  });

  test.describe("fallback host", () => {
    const FALLBACK = "https://fallback.example.org/neat/youtube/rules.json";
    // Primary host behaves per `primary`; the fallback host serves `fb` (both signed with the trusted key unless overridden).
    const twoHosts = (primary, fb) => {
      const calls = [];
      const fn = async (url, init) => {
        calls.push(url);
        return (url.startsWith(FALLBACK) ? fb : primary)(url, init);
      };
      fn.calls = calls;
      return fn;
    };
    const makeFb = (f, storage = fakeStorage()) =>
      ({ storage, u: createUpdater({ site: "youtube", bundled, rulesUrl: URL_OK, fallbackUrl: FALLBACK, publicKey: KEYS_.publicJwk, storage, fetchImpl: f, now: () => 1 }) });

    test("is not contacted when the primary host works", async () => {
      const f = twoHosts(fakeFetch(doc("1.0.0")), fakeFetch(doc("2.0.0")));
      const { u } = makeFb(f);
      expect((await u.refresh("install")).status).toBe("up-to-date (1.0.0)");
      expect(f.calls.every((c) => c.startsWith(URL_OK))).toBe(true);
    });

    test("serves the update when the primary host is down", async () => {
      const f = twoHosts(fakeFetch(new TypeError("Failed to fetch")), fakeFetch(doc("1.3.0")));
      const { u, storage } = makeFb(f);
      expect((await u.refresh("install")).updated).toBe(true);
      expect(storage.data.rules.version).toBe("1.3.0");
      expect(f.calls.sort()).toEqual([FALLBACK, `${FALLBACK}.sig`, URL_OK, `${URL_OK}.sig`].sort());
    });

    test("is held to the same signature check, and both failures are reported", async () => {
      const f = twoHosts(fakeFetch("x", { status: 503 }), fakeFetch(doc("2.0.0"), { signer: OTHER }));
      const { u, storage } = makeFb(f, fakeStorage({ rules: doc("1.1.0") }));
      const r = await u.refresh("install");
      expect(r.updated).toBe(false);
      expect(r.status).toMatch(/^fetch failed: http 503 .*; fallback rejected: signature/);
      expect(storage.data.rules.version).toBe("1.1.0");
    });

    test("an invalid or placeholder fallback is ignored", async () => {
      for (const fallbackUrl of ["http://plain.example.org/r.json", "https://RULES_HOST/r.json", "not a url"]) {
        const f = fakeFetch(new TypeError("Failed to fetch"));
        const storage = fakeStorage();
        const u = createUpdater({ site: "youtube", bundled, rulesUrl: URL_OK, fallbackUrl, publicKey: KEYS_.publicJwk, storage, fetchImpl: f, now: () => 1 });
        await u.refresh("install");
        expect(f.calls.every((c) => c.url.startsWith(URL_OK))).toBe(true);
      }
    });
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
    expect(f.rulesCalls().length).toBe(3);
  });

  test("coalesces concurrent refreshes into one request", async () => {
    const f = fakeFetch(doc("1.2.0"));
    const { u } = make(f);
    await Promise.all([u.refresh("install"), u.refresh("recheck"), u.refresh("recheck")]);
    expect(f.rulesCalls().length).toBe(1);
  });

  test("pickRules prefers newer valid stored rules, else bundled", () => {
    expect(pickRules(bundled, doc("1.1.0"), "youtube").source).toBe("remote");
    expect(pickRules(bundled, doc("0.1.0"), "youtube").source).toBe("bundled");
    expect(pickRules(bundled, { ...doc("9.0.0"), x: 1 }, "youtube").source).toBe("bundled");
    expect(pickRules(bundled, { ...doc("9.0.0"), site: "reddit" }, "youtube").source).toBe("bundled");
    expect(pickRules(bundled, null, "youtube").source).toBe("bundled");
  });

  test("remote rules cannot relabel a shipped rule or flip its default; new rules keep theirs", () => {
    const remote = doc("1.5.0");
    remote.rules[0] = { ...remote.rules[0], label: "Totally harmless", default: false, group: "Other" };
    remote.rules.push({ id: "new-one", label: "New", default: true, group: "G", locators: [{ type: "css", selector: "div.n" }] });
    const picked = pickRules(bundled, remote, "youtube").doc.rules;
    expect(picked[0]).toMatchObject({ id: "a", label: "A", default: true, group: "G" });
    expect(picked[1]).toMatchObject({ id: "new-one", label: "New", default: true });
  });
});
