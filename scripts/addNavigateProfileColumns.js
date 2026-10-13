// One-off migration: adds the MIGRA Navigate deep-assessment columns to `migration_profiles`
// (2026-09-28) — see src/db/models.js's "Navigate deep-assessment fields" block for the
// Sequelize side. Same idempotent ALTER TABLE pattern as scripts/addDiscoverProfileColumns.js.
//
// Usage: node scripts/addNavigateProfileColumns.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

const TABLE = "migration_profiles";

const NEW_COLUMNS = [
  ["target_salary", "VARCHAR(120) NULL"],
  ["language_test_type", "VARCHAR(50) NULL"],
  ["language_test_score", "VARCHAR(50) NULL"],
  ["admission_status", "VARCHAR(50) NULL"],
  ["tuition_budget", "VARCHAR(50) NULL"],
  ["business_model", "TEXT NULL"],
  ["target_market", "VARCHAR(120) NULL"],
  ["licensing_exams_completed", "TINYINT(1) NULL"],
  ["offer_sponsorship", "TINYINT(1) NULL"],
  ["offer_details", "TEXT NULL"],
  ["navigate_started_at", "DATE NULL"],
  ["navigate_profile_confirmed", "TINYINT(1) NULL"],
];

async function main() {
  await connectDb();
  const qi = sequelize.getQueryInterface();
  const existing = await qi.describeTable(TABLE);

  let added = 0;
  for (const [name, ddl] of NEW_COLUMNS) {
    if (existing[name]) {
      console.log(`Column ${TABLE}.${name} already exists — skipping.`);
      continue;
    }
    console.log(`Adding column ${TABLE}.${name} ${ddl}...`);
    await sequelize.query(`ALTER TABLE ${TABLE} ADD COLUMN ${name} ${ddl}`);
    added += 1;
  }

  console.log(`Migration complete. ${added} column(s) added, ${NEW_COLUMNS.length - added} already present.`);
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
