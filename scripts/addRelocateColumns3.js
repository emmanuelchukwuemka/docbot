// One-off migration: adds Application.government_reference_number (the real government/
// institution reference once a case has been lodged, e.g. a UK visa GWF number -- staff-
// entered only). Same idempotent ALTER TABLE pattern as every other migration script here.
//
// Usage: node scripts/addRelocateColumns3.js

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

  const total = await addMissingColumns(qi, "applications", [
    ["government_reference_number", "VARCHAR(120) NULL"],
  ]);

  console.log(`Migration complete. ${total} column(s) added.`);
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
