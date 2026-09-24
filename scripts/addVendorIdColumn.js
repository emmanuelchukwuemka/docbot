// One-off migration: adds the `vendor_id` column to the `applications` table. The
// Application model (db/models.js) declares it as part of the 2026-09-01 partner-agent
// dashboard feature, but — same reasoning as scripts/addPaymentColumns.js —
// sequelize.sync() without {alter:true} never adds columns to a table that already exists,
// and `applications` has existed (with real data) since long before this feature. Without
// this, every case-assignment/messaging/commission query against Application.vendor_id
// would fail with `Unknown column 'vendor_id' in 'field list'`.
//
// Idempotent — safe to run more than once. Does NOT touch the new `vendors`,
// `case_messages`, or `commissions` tables — those are brand new, so sequelize.sync() (which
// production runs on every boot, see server.js) creates them correctly on its own; only new
// columns on a pre-existing table need this explicit path.
//
// Usage: node scripts/addVendorIdColumn.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

async function main() {
  await connectDb();
  const qi = sequelize.getQueryInterface();
  const existing = await qi.describeTable("applications");

  if (existing.vendor_id) {
    console.log("Column applications.vendor_id already exists — skipping.");
  } else {
    console.log("Adding column applications.vendor_id CHAR(36) NULL...");
    await sequelize.query("ALTER TABLE applications ADD COLUMN vendor_id CHAR(36) NULL");
    console.log("  done.");
  }

  console.log("Migration complete.");
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
