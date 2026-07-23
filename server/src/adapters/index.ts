import { MockBankAdapter } from "./MockBankAdapter.js";
import { signServerReceipt } from "../crypto/serverSigner.js";
import { db } from "../db/kysely.js";

/** The one IBankAdapter instance the running server uses -- wired with the real
 * COSE signer (server/src/crypto/serverSigner.ts), not the test stubs adapter
 * tests inject directly. */
export const bankAdapter = new MockBankAdapter(db, signServerReceipt);
