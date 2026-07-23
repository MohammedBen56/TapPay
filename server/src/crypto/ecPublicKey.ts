import type { KeyObject } from "node:crypto";

/** SEC1-compressed 33-byte P-256 public key (0x02/0x03 prefix + x), matching
 * this project's identity_pubkey wire format (spec §2.2) -- not the uncompressed
 * or DER/SPKI forms Node's other export options give directly. */
export function compressedPublicKeyFromKeyObject(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const yIsOdd = (y[y.length - 1]! & 1) === 1;
  return new Uint8Array(Buffer.concat([Buffer.from([yIsOdd ? 0x03 : 0x02]), x]));
}
