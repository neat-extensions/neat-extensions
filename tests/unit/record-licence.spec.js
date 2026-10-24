// Licence keys: signed offline, verified with the public key in the extension.
import { test, expect } from "@playwright/test";
import { verifyLicence, cleanLicenceInput, encodeLicence, toB64url, fromB64url } from "../../packages/engine/src/licence.js";
import { signLicence, generateLicenceKeyPair } from "../../scripts/licence-sign.mjs";

let keys;
test.beforeAll(async () => {
  keys = await generateLicenceKeyPair();
});

test.describe("licence keys", () => {
  test("a valid key unlocks and carries the licence terms", async () => {
    const key = await signLicence(keys.privateJwk, { product: "record", purchaserId: "cus_123", issued: "2026-10-23" });
    const r = await verifyLicence(keys.publicJwk, key, "record");
    expect(r.ok).toBe(true);
    expect(r.payload).toMatchObject({ v: 1, product: "record", issued: "2026-10-23", seats: 3 });
    // The subject is random: nothing in the key says who bought it.
    expect(r.payload.sub).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(JSON.stringify(r.payload)).not.toContain("cus_123");
    expect(key.length).toBeLessThan(260);
  });

  test("pasted with spaces, line breaks or quotes still works", async () => {
    const key = await signLicence(keys.privateJwk, { product: "record", purchaserId: "a@b.c" });
    const messy = `  "${key.slice(0, 40)}\n ${key.slice(40, 90)}\t${key.slice(90)}"  `;
    expect(cleanLicenceInput(messy)).toBe(key);
    expect((await verifyLicence(keys.publicJwk, messy, "record")).ok).toBe(true);
  });

  test("a tampered payload is rejected", async () => {
    const key = await signLicence(keys.privateJwk, { product: "record", purchaserId: "x" });
    const [p, s] = key.split(".");
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    payload.seats = 99;
    const forged = `${toB64url(new TextEncoder().encode(JSON.stringify(payload)))}.${s}`;
    expect(await verifyLicence(keys.publicJwk, forged, "record")).toEqual({ ok: false, reason: "signature" });
    // One flipped character in the signature as well.
    const flipped = key.slice(0, -2) + (key.at(-2) === "A" ? "B" : "A") + key.at(-1);
    expect((await verifyLicence(keys.publicJwk, flipped, "record")).ok).toBe(false);
  });

  test("a key signed by another private key is rejected", async () => {
    const other = await generateLicenceKeyPair();
    const key = await signLicence(other.privateJwk, { product: "record", purchaserId: "x" });
    expect(await verifyLicence(keys.publicJwk, key, "record")).toEqual({ ok: false, reason: "signature" });
  });

  test("a key for another product is rejected", async () => {
    const key = await signLicence(keys.privateJwk, { product: "tabs", purchaserId: "x" });
    expect(await verifyLicence(keys.publicJwk, key, "record")).toEqual({ ok: false, reason: "product" });
  });

  test("a correctly signed key in an old or unknown format is rejected", async () => {
    const old = await signLicence(keys.privateJwk, { product: "record", purchaserId: "x", v: 0 });
    expect(await verifyLicence(keys.publicJwk, old, "record")).toEqual({ ok: false, reason: "version" });
    const sign = async (bytes) => {
      const k = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, bytes));
    };
    const badDate = await encodeLicence({ v: 1, product: "record", issued: "yesterday", seats: 3, sub: "x" }, sign);
    expect(await verifyLicence(keys.publicJwk, badDate, "record")).toEqual({ ok: false, reason: "version" });
  });

  test("a revoked key (refunded or leaked) stops unlocking", async () => {
    const key = await signLicence(keys.privateJwk, { product: "record", purchaserId: "refunded" });
    const { sub } = (await verifyLicence(keys.publicJwk, key, "record")).payload;
    expect(await verifyLicence(keys.publicJwk, key, "record", { revoked: [sub] })).toEqual({ ok: false, reason: "revoked" });
    expect((await verifyLicence(keys.publicJwk, key, "record", { revoked: ["someone-else"] })).ok).toBe(true);
  });

  test("garbage never throws", async () => {
    for (const s of ["", "abc", "a.b", "x".repeat(500), null, 42, "😀.😀", `${"A".repeat(40)}.${"A".repeat(86)}`]) {
      const r = await verifyLicence(keys.publicJwk, s, "record");
      expect(r.ok, String(s)).toBe(false);
    }
  });
});
