# Restore drill log

Dated rows, oldest first. Each run dumps the real dev database, restores it into a throwaway container, and runs checkLedgerInvariants() against the restored copy -- see server/scripts/restore-drill.ts.

| Date (UTC) | Restore time | Total time | Result |
|---|---|---|---|
| 2026-08-19T18:22:26.221Z | 781ms | 2951ms | ✅ clean |
