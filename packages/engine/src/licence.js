// Offline licence keys. A key is "<payload>.<signature>", both base64url:
//   payload   = UTF-8 JSON {v, product, issued, seats, sub}
//   signature = ECDSA P-256 / SHA-256 over the payload bytes (raw r‖s, 64 bytes)
// Verified with the public key built into the extension, so unlocking needs no
// server and no account. `seats` is a licence term (3 computers), not enforced.
// Runs in extension pages, service workers, Node 20+ and Cloudflare Workers.

export const LICENCE_VERSION = 1;
const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const KEY_RE = /^[A-Za-z0-9_-]{20,400}\.[A-Za-z0-9_-]{86}$/;

export function toB64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param sign async (bytes) => Uint8Array(64) */
export async function encodeLicence(payload, sign) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return `${toB64url(bytes)}.${toB64url(await sign(bytes))}`;
}

/** Keys are long; people paste them with spaces, line breaks or quotes around them. */
export function cleanLicenceInput(s) {
  return typeof s === "string" ? s.replace(/[\s"'`<>]/g, "") : "";
}

/**
 * @param {{revoked?: string[]}} [opts] subjects of refunded or leaked keys (shipped with the extension)
 * @returns {Promise<{ok: true, payload: object} | {ok: false, reason: "format"|"signature"|"product"|"version"|"revoked"}>}
 */
export async function verifyLicence(publicJwk, key, product, { revoked = [] } = {}) {
  const k = cleanLicenceInput(key);
  if (!KEY_RE.test(k)) return { ok: false, reason: "format" };
  const [p, s] = k.split(".");
  let payloadBytes, sig;
  try {
    payloadBytes = fromB64url(p);
    sig = fromB64url(s);
  } catch {
    return { ok: false, reason: "format" };
  }
  if (sig.length !== 64) return { ok: false, reason: "format" };
  let valid;
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y }, ALG, false, ["verify"]);
    valid = await crypto.subtle.verify(SIGN, pub, sig, payloadBytes);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature" };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return { ok: false, reason: "format" };
  }
  if (!payload || typeof payload !== "object") return { ok: false, reason: "format" };
  // A correctly signed key in an older or unknown format is refused, never guessed at.
  if (payload.v !== LICENCE_VERSION || typeof payload.issued !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(payload.issued)) return { ok: false, reason: "version" };
  if (payload.product !== product) return { ok: false, reason: "product" };
  if (revoked.includes(payload.sub)) return { ok: false, reason: "revoked" };
  return { ok: true, payload };
}
