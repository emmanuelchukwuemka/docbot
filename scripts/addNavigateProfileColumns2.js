// One-off migration: Navigate gap-closing round 2 (2026-09-28) -- adds the remaining
// adaptive-assessment MigrationProfile columns, Document.extracted_fields (real vision-
// extraction output), and EligibilityAssessment.pathway_version. Same idempotent ALTER TABLE
// pattern as every other migration script in this folder.
//
// Usage: node scripts/addNavigateProfileColumns2.js

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
  total += await addMissingColumns(qi, "migration_profiles", [
    ["academic_results", "VARCHAR(255) NULL"],
    ["business_history", "TEXT NULL"],
    ["business_ownership", "VARCHAR(120) NULL"],
    ["sponsor_status", "VARCHAR(120) NULL"],
    ["destination_specific_registration", "VARCHAR(255) NULL"],
    ["offer_legitimacy_confirmed", "TINYINT(1) NULL"],
  ]);
  total += await addMissingColumns(qi, "documents", [
    ["extracted_fields", "JSON NULL"],
  ]);
  total += await addMissingColumns(qi, "eligibility_assessments", [
    ["pathway_version", "VARCHAR(20) NULL"],
  ]);

  console.log(`Migration complete. ${total} column(s) added across 3 tables.`);
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
