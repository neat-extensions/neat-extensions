// Rules files are signed by the owner (ECDSA P-256 / SHA-256, WebCrypto) and the
// public key ships inside the extension. A rules file whose signature does not
// verify is never parsed, so a compromised or mistaken rules host cannot push rules.

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };

export function isPublicJwk(jwk) {
  return !!jwk && typeof jwk === "object" && jwk.kty === "EC" && jwk.crv === "P-256" && typeof jwk.x === "string" && typeof jwk.y === "string" && !("d" in jwk);
}

function fromBase64(b64) {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @returns {Promise<boolean>} true only for a well-formed signature by the shipped key. */
export async function verifyRules(publicJwk, bytes, signatureB64) {
  if (!isPublicJwk(publicJwk) || typeof signatureB64 !== "string") return false;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: publicJwk.x, y: publicJwk.y }, ALG, false, ["verify"]);
    const sig = fromBase64(signatureB64);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify(SIGN, key, sig, bytes);
  } catch {
    return false;
  }
}
