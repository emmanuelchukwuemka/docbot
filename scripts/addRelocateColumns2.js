// One-off migration: Relocate gap-closing round -- adds consent/module-enable columns to
// applications and real appointment-scheduling columns to consultation_bookings. The new
// service_items table is NOT created here -- it's picked up automatically by the existing
// syncModels() call on next server boot (plain sequelize.sync(), the same mechanism that
// originally created the vendors/case_messages/commissions tables -- see db/models.js).
// Same idempotent ALTER TABLE pattern as every other migration script in this folder.
//
// Usage: node scripts/addRelocateColumns2.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

async function addMissingColumns(qi, table, columns) {
  const existing = await qi.describeTable(table);
  let added = 0;
  for (const [name, ddl] of columns) {
    if (existing[name]) {
      console.log(`Column ${table}.${name} already exists — skipping.`);
      continue;
    }
    console.log(`Adding column ${table}.${name} ${ddl}...`);
    await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    added += 1;
  }
  return added;
}

async function main() {
  await connectDb();
  const qi = sequelize.getQueryInterface();

  let total = 0;
  total += await addMissingColumns(qi, "applications", [
    ["relocate_consent_given_at", "DATETIME NULL"],
    ["departure_module_enabled", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["settlement_module_enabled", "TINYINT(1) NOT NULL DEFAULT 0"],
  ]);
  total += await addMissingColumns(qi, "consultation_bookings", [
    ["scheduled_at", "DATETIME NULL"],
    ["appointment_reminder_sent_at", "DATETIME NULL"],
  ]);

  console.log(`Migration complete. ${total} column(s) added across 2 tables.`);
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
