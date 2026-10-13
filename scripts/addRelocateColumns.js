// One-off migration: MIGRA Relocate build -- adds Application.relocate_phase/
// relocate_started_at/last_relocate_reminder_sent_at and Document.expiry_date/review_notes.
// Same idempotent ALTER TABLE pattern as every other migration script in this folder.
//
// Usage: node scripts/addRelocateColumns.js

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
    ["relocate_phase", "VARCHAR(50) NULL"],
    ["relocate_started_at", "DATETIME NULL"],
    ["last_relocate_reminder_sent_at", "DATETIME NULL"],
  ]);
  total += await addMissingColumns(qi, "documents", [
    ["expiry_date", "DATE NULL"],
    ["review_notes", "TEXT NULL"],
  ]);

  console.log(`Migration complete. ${total} column(s) added across 2 tables.`);
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
