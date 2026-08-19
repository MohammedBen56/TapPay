# 0002 — Bearer-token-shaped `TxReceipt`

**Class:** client-suppliable identifier insufficiently bound to its scope
**Found via:** `/security-review`
**Status:** Fixed (parked path only — see below)

## Impact

A server-signed `TxReceipt` (the parked P2P path's proof of settlement,
scanned or fetched by the payee's device) carried no binding to *which*
device was supposed to receive it. A receipt is, functionally, a bearer
token: whoever holds a validly-signed one can present it as proof of
payment. Without naming the intended payee inside the signed payload, a
receipt legitimately issued for one recipient could be replayed against a
different verifier that failed to check it was actually the party the
payment was meant for — a settlement-forgery vector, not merely an
information leak.

## Timeline

Found during the same `/security-review` pass that surfaced 0001, while
auditing every place a signed artifact crosses a trust boundary in the
COSE-signed settlement path.

## Root cause

The receipt's signed payload bound the transaction (`tx_uuid`, amount,
currency, settlement time) but not the *recipient* — `recipientDeviceId`
and `receiverNonce` were not part of what got signed, so a verifier had no
cryptographic way to confirm a receipt was meant for them specifically
versus meant for anyone who happened to be shown it.

## Fix

`recipientDeviceId` and `receiverNonce` are now bound inside the signed
COSE_Sign1 payload itself (not carried alongside it, where they could be
swapped without invalidating the signature), and every verifier checks a
scanned/fetched receipt against what it actually expects — its own device
ID and the nonce it itself generated — before trusting it. `MockBankAdapter`
takes explicit `recipientDeviceId`/`receiverNonce` fields as part of
`TransferContext` specifically so this binding happens at signing time, not
bolted on after.

## Scope note — this is closed for the live v2 app for a different reason

The live v2 `/transfers` route has no separate receipt-fetch step at all —
the settlement response *is* the confirmation, scoped by the caller's own
JWT `aid` claim, so this vulnerability class doesn't apply to the shipping
product today. That's a closure by different design, not by this fix
reaching the v2 path; the fix itself lives entirely in the parked COSE
receipt code, which only matters again if that path is un-parked.

## Prevention

- The receipt-binding check is covered by the parked path's own test suite
  (`server/src/parked/` — adversarial receipt-forgery cases).
- `docs/THREAT_MODEL.md` (planned, Phase 0) records this as a closed-by-fix
  row for the parked path, distinct from CLAUDE.md's other "closed by
  parking" entries — worth keeping that distinction explicit, since the two
  read very differently in a due-diligence conversation.
