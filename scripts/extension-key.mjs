// Pins a Chrome extension ID: generates the RSA key whose public half goes in the
// manifest "key" field (Chrome derives the ID from it). The private half stays in
// .secrets/ (git-ignored, backed up to %USERPROFILE%\Documents\Neat-keys\) and is
// never printed. Only the public key and the ID are printed.
//
//   node scripts/extension-key.mjs generate <app>   → .secrets/<app>-extension-key.pem
//   node scripts/extension-key.mjs show <app>       → public key + ID (from the .pem)
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** The extension ID Chrome derives from a manifest "key" (base64 SPKI DER). */
export function extensionIdFromKey(keyB64) {
  const hex = createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function publicFromPem(pem) {
  return createPublicKey(createPrivateKey(pem)).export({ type: "spki", format: "der" }).toString("base64");
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const [cmd, app] = process.argv.slice(2);
  if (!app || !/^[a-z0-9-]+$/.test(app) || !["generate", "show"].includes(cmd)) {
    console.log("usage: extension-key.mjs generate|show <app>");
    process.exit(2);
  }
  const file = path.join(ROOT, ".secrets", `${app}-extension-key.pem`);
  if (cmd === "generate") {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx" }).catch(() => {
      console.error(`${file} already exists — refusing to overwrite (the extension ID would change).`);
      process.exit(1);
    });
  }
  const key = publicFromPem(await readFile(file, "utf8"));
  console.log(`manifest key (public): ${key}`);
  console.log(`extension ID: ${extensionIdFromKey(key)}`);
}
