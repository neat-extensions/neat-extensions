// Licence keys for paid features (ECDSA P-256 / SHA-256, the same scheme as the
// rules signature). Offline-verifiable: the public key ships in the extension.
// The private key lives in .secrets/licence-private.jwk (git-ignored, backed up
// to %USERPROFILE%\Documents\Neat-keys\) and is never printed.
//
//   node scripts/licence-sign.mjs generate                      → .secrets/licence-private.jwk + prints the public JWK
//   node scripts/licence-sign.mjs sign <product>                 → prints a licence key and its subject id (keep it for refunds)
//   LICENCE_PRIVATE_KEY_FILE=… overrides the key path.
import { webcrypto as crypto } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodeLicence, LICENCE_VERSION, toB64url } from "../packages/engine/src/licence.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEY_FILE = process.env.LICENCE_PRIVATE_KEY_FILE || path.join(ROOT, ".secrets", "licence-private.jwk");
const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };

/** A random subject id: names the purchase (for a refund or a leak) without saying who bought it. */
export function randomSub() {
  return toB64url(crypto.getRandomValues(new Uint8Array(12)));
}

export async function signLicence(privateJwk, { product, sub = randomSub(), issued = new Date().toISOString().slice(0, 10), seats = 3, v = LICENCE_VERSION }) {
  const payload = { v, product, issued, seats, sub };
  const key = await crypto.subtle.importKey("jwk", privateJwk, ALG, false, ["sign"]);
  return encodeLicence(payload, async (bytes) => new Uint8Array(await crypto.subtle.sign(SIGN, key, bytes)));
}

export async function generateLicenceKeyPair() {
  const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { privateJwk, publicJwk: { kty, crv, x, y } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [cmd, product] = process.argv.slice(2);
  if (cmd === "generate") {
    const { privateJwk, publicJwk } = await generateLicenceKeyPair();
    await mkdir(path.dirname(KEY_FILE), { recursive: true });
    await writeFile(KEY_FILE, JSON.stringify(privateJwk), { flag: "wx" }).catch(() => {
      console.error(`${KEY_FILE} already exists — refusing to overwrite a signing key.`);
      process.exit(1);
    });
    console.log(`Private key: ${KEY_FILE} (keep secret, back it up, never commit)`);
    console.log(`Public key — put in apps/<app>/app.config.js licencePublicKey:\n${JSON.stringify(publicJwk)}`);
  } else if (cmd === "sign" && product) {
    const sub = randomSub();
    console.log(await signLicence(JSON.parse(await readFile(KEY_FILE, "utf8")), { product, sub }));
    console.log(`subject id (for refunds: add it to revokedLicences): ${sub}`);
  } else {
    console.log("usage: licence-sign.mjs generate | sign <product>");
    process.exit(2);
  }
}
