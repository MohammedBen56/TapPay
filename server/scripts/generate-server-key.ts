/**
 * One-time (per environment) generation of the server's own P-256 identity key,
 * used to sign COSE_Sign1 receipts (CommitResult.receiptSignature). Writes the
 * private key to server/keys/server_identity.pem (gitignored) and prints the
 * raw 33-byte compressed public key as hex -- pin that into
 * mobile/src/config/serverPublicKey.ts (Step 9), the one exception to "no
 * secrets in the app binary" (CLAUDE.md §6: it's a public key, verifying
 * receipts, not a secret).
 *
 * Refuses to overwrite an existing key -- regenerating silently would orphan
 * every previously issued receipt (mobile's pinned public key would no longer
 * match).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { config } from "../src/config.js";
import { compressedPublicKeyFromKeyObject } from "../src/crypto/ecPublicKey.js";

if (existsSync(config.serverIdentityKeyPath)) {
  console.error(`refusing to overwrite existing key at ${config.serverIdentityKeyPath}`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

mkdirSync(dirname(config.serverIdentityKeyPath), { recursive: true });
writeFileSync(config.serverIdentityKeyPath, privateKey.export({ type: "sec1", format: "pem" }));

const compressed = Buffer.from(compressedPublicKeyFromKeyObject(publicKey));

console.log(`private key written to ${config.serverIdentityKeyPath}`);
console.log(`public key (hex, pin into mobile/src/config/serverPublicKey.ts):`);
console.log(compressed.toString("hex"));
