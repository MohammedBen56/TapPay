// Postgres never auto-indexes the referencing side of a foreign key --
// bill_payments.biller_id was missing one despite every GET /bill-payments*
// query (server/src/routes/billPayments.ts) joining billers on it. Found in
// the optimization audit that followed the bill-payments feature itself.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`CREATE INDEX idx_bill_payments_biller ON bill_payments (biller_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX idx_bill_payments_biller;`);
};
