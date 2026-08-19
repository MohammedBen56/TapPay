function bad1(globalImbalance: bigint) {
  // ruleid: no-float-money
  ledgerImbalanceMinor.set(Number(globalImbalance));
}

function bad2(accountBalance: string) {
  // ruleid: no-float-money
  const display = accountBalance.toFixed(2);
}

function bad3(amountStr: string) {
  // ruleid: no-float-money
  const n = parseFloat(amountStr);
}

function good1(count: number) {
  // ok: no-float-money
  const n = Number(count);
}

function good2(minorUnits: bigint) {
  // ok: no-float-money
  // nosemgrep: no-float-money -- metrics layer, no bigint gauge type exists, see tripwire.ts
  ledgerImbalanceMinor.set(Number(minorUnits));
}
