// Rules signing (ECDSA P-256 / SHA-256). The private key never leaves the owner's
// machine (.keys/ is git-ignored); the public key is built into the extension.
//
//   node scripts/rules-key.mjs generate            → .keys/rules-private.jwk + prints the public JWK
//   node scripts/rules-key.mjs sign <rules.json>   → writes <rules.json>.sig next to it
//   node scripts/rules-key.mjs verify <rules.json> <public.jwk|json>
import { webcrypto as crypto } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const KEY_FILE = process.env.RULES_PRIVATE_KEY_FILE || path.join(ROOT, ".keys", "rules-private.jwk");
const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };

export async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return { privateJwk: priv, publicJwk: { kty, crv, x, y } };
}

export async function signBytes(privateJwk, bytes) {
  const key = await crypto.subtle.importKey("jwk", privateJwk, ALG, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign(SIGN, key, bytes)).toString("base64");
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [cmd, file, pub] = process.argv.slice(2);
  if (cmd === "generate") {
    const { privateJwk, publicJwk } = await generateKeyPair();
    await mkdir(path.dirname(KEY_FILE), { recursive: true });
    await writeFile(KEY_FILE, JSON.stringify(privateJwk), { flag: "wx" }).catch(() => {
      console.error(`${KEY_FILE} already exists — refusing to overwrite a signing key.`);
      process.exit(1);
    });
    console.log(`Private key: ${KEY_FILE} (keep secret, back it up, never commit)`);
    console.log(`Public key — put in apps/<site>/site.config.js rulesPublicKey, or pass RULES_PUBLIC_KEY at build time:\n${JSON.stringify(publicJwk)}`);
  } else if (cmd === "sign" && file) {
    const sig = await signBytes(JSON.parse(await readFile(KEY_FILE, "utf8")), await readFile(file));
    await writeFile(`${file}.sig`, sig);
    console.log(`wrote ${file}.sig — publish it next to ${path.basename(file)}`);
  } else if (cmd === "verify" && file && pub) {
    const { verifyRules } = await import("../packages/engine/src/signature.js");
    const jwk = JSON.parse(pub.trim().startsWith("{") ? pub : await readFile(pub, "utf8"));
    const ok = await verifyRules(jwk, await readFile(file), await readFile(`${file}.sig`, "utf8"));
    console.log(ok ? "signature OK" : "signature INVALID");
    process.exit(ok ? 0 : 1);
  } else {
    console.log("usage: rules-key.mjs generate | sign <rules.json> | verify <rules.json> <public-jwk>");
    process.exit(2);
  }
}
