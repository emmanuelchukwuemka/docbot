// One-off migration: adds the `tier` and `provider` columns to the `payments` table. The
// Payment model (db/models.js) has declared both for a while (Paystack integration +
// NAVIGATE/RELOCATE pricing work), but — same as users.password_hash/country/state —
// sequelize.sync() without {alter:true} never adds columns to a table that already exists,
// so any DB migrated before those changes is missing them. Discovered 2026-08-29 testing the
// portal feature: the admin Payments page and this dev DB were both silently broken
// (`Unknown column 'tier'/'provider' in 'field list'`) until this ran.
//
// Idempotent — safe to run more than once.
//
// Usage: node scripts/addPaymentColumns.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

const NEW_COLUMNS = {
  tier: "VARCHAR(20) NULL",
  provider: "VARCHAR(20) NULL DEFAULT 'manual'",
};

async function main() {
  await connectDb();
  const qi = sequelize.getQueryInterface();
  const existing = await qi.describeTable("payments");

  for (const [name, ddl] of Object.entries(NEW_COLUMNS)) {
    if (existing[name]) {
      console.log(`Column payments.${name} already exists — skipping.`);
      continue;
    }
    console.log(`Adding column payments.${name} ${ddl}...`);
    await sequelize.query(`ALTER TABLE payments ADD COLUMN ${name} ${ddl}`);
    console.log("  done.");
  }

  console.log("Migration complete.");
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
