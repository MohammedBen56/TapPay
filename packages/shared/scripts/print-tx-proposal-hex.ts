/**
 * Manual Hermes byte-identity check (M1 Step 5). Encodes a fixed TxProposal and
 * prints the hex. Run this with `tsx` on the server (Node) and log the same
 * call's output from the mobile dev-client app (Hermes) -- the two hex strings
 * must be byte-for-byte identical, or the shared COSE/CBOR layer cannot be
 * trusted to interop between server and phone.
 *
 * Why this needs manual, on-device confirmation rather than an automated test:
 * this sandbox has no runnable Hermes VM (only hermes-compiler's `hermesc`,
 * which is compile-only in this distribution -- no `-exec` support). What WAS
 * confirmed here, headlessly:
 *   - cbor-x's default import surface (encode.js) contains an `async function*`
 *     (encodeObjectAsAsyncIterable, part of its streaming API, never called by
 *     this project). Hermes's compiler rejects that syntax outright -- bundling
 *     this package untransformed and feeding it to hermesc fails to even parse.
 *   - The same bundle, downleveled the way Metro's Babel pipeline normally
 *     downlevels modern syntax for Hermes (esbuild --target=es2017, forcing
 *     async-generator transpilation), compiles cleanly under hermesc.
 * That's reassuring but not conclusive -- it proves the code CAN be made
 * Hermes-compatible via standard transpilation, not that this project's actual
 * Metro/Babel config does so, and it says nothing about RUNTIME output (does the
 * downleveled code actually encode the same bytes?). Only a real dev-client run
 * settles that, which needs a phone -- hence this script instead of a CI test.
 */
import { encodeTxProposal } from "../src/crypto/cbor.js";
import type { TxProposal } from "../src/types.js";

function bytes16(fill: number): Uint8Array {
  return new Uint8Array(16).fill(fill);
}

// Fixed, arbitrary values -- the point is that both platforms encode the exact
// same input, not that the input means anything.
export const HERMES_CHECK_FIXTURE: TxProposal = {
  tx_uuid: bytes16(1),
  sender_device_id: bytes16(2),
  recipient_device_id: bytes16(3),
  amount: 9_007_199_254_740_993n, // MAX_SAFE_INTEGER + 2 -- exercises bigint encoding too
  currency: "MAD",
  receiver_nonce: bytes16(4),
  ts: 1_784_764_600_000,
};

// Reference value from `npx tsx scripts/print-tx-proposal-hex.ts` on the server
// (Node) -- the mobile dev-client's logged output must match this exactly.
export const NODE_REFERENCE_HEX =
  "875001010101010101010101010101010101500202020202020202020202020202020250030303030303030303030303030303031b0020000000000001634d41445004040404040404040404040404040404fb4279f8c428ec0000";

export function printTxProposalHex(): void {
  const bytes = encodeTxProposal(HERMES_CHECK_FIXTURE);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  // eslint-disable-next-line no-console
  console.log(hex);
}

printTxProposalHex();
