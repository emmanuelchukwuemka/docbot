// One-off migration: adds the ~45 new `migration_profiles` columns for the redesigned
// MIGRA Discover deep intake (2026-09-28) — see src/db/models.js's "Discover deep-intake
// fields" block for the Sequelize side of these same columns. sequelize.sync() never adds
// columns to a table that already exists (see models.js's own note on why {alter:true} is
// banned against production), so this explicit ALTER TABLE path is required, same pattern as
// every other one-off column script in this folder.
//
// Idempotent — checks each column against the table's current description before adding it,
// safe to re-run.
//
// Usage: node scripts/addDiscoverProfileColumns.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

const TABLE = "migration_profiles";

const NEW_COLUMNS = [
  ["date_of_birth", "DATE NULL"],
  ["gender", "VARCHAR(50) NULL"],
  ["nationality", "VARCHAR(120) NULL"],
  ["other_citizenship_or_pr", "VARCHAR(255) NULL"],
  ["preferred_language", "VARCHAR(50) NULL"],
  ["migration_reason", "VARCHAR(50) NULL"],
  ["migration_goal_detail", "TEXT NULL"],
  ["has_destination_in_mind", "VARCHAR(20) NULL"],
  ["destination_countries", "VARCHAR(255) NULL"],
  ["destination_interest_reason", "TEXT NULL"],
  ["destination_flexibility", "VARCHAR(50) NULL"],
  ["field_of_study", "VARCHAR(255) NULL"],
  ["institution", "VARCHAR(255) NULL"],
  ["graduation_year", "INT NULL"],
  ["certifications", "VARCHAR(255) NULL"],
  ["job_title", "VARCHAR(120) NULL"],
  ["industries", "VARCHAR(255) NULL"],
  ["key_skills", "VARCHAR(255) NULL"],
  ["employment_status", "VARCHAR(50) NULL"],
  ["employment_type", "VARCHAR(50) NULL"],
  ["income_range", "VARCHAR(50) NULL"],
  ["travelled_before", "TINYINT(1) NULL"],
  ["travel_history", "TEXT NULL"],
  ["returned_on_time", "TINYINT(1) NULL"],
  ["visa_applied_before", "TINYINT(1) NULL"],
  ["visa_type_applied", "VARCHAR(120) NULL"],
  ["visa_refused_before", "TINYINT(1) NULL"],
  ["visa_refusal_country", "VARCHAR(120) NULL"],
  ["visa_refusal_type", "VARCHAR(120) NULL"],
  ["visa_refusal_when", "VARCHAR(50) NULL"],
  ["visa_refusal_reason", "TEXT NULL"], // encrypted at the application layer, see models.js
  ["migrating_with", "VARCHAR(50) NULL"],
  ["marital_status", "VARCHAR(50) NULL"],
  ["has_dependents", "TINYINT(1) NULL"],
  ["dependents_count", "INT NULL"],
  ["dependents_ages", "VARCHAR(255) NULL"],
  ["dependents_migrating", "TINYINT(1) NULL"],
  ["family_abroad", "TINYINT(1) NULL"],
  ["family_abroad_country", "VARCHAR(120) NULL"],
  ["family_abroad_relationship", "VARCHAR(120) NULL"],
  ["family_abroad_status", "VARCHAR(120) NULL"],
  ["funding_source", "VARCHAR(50) NULL"],
  ["destination_priorities", "JSON NULL"],
  ["migration_concerns", "JSON NULL"],
  ["biggest_question", "TEXT NULL"],
  ["confidence_level", "INT NULL"],
  ["wants_navigate", "VARCHAR(20) NULL"],
  ["asylum_context_detail", "TEXT NULL"], // encrypted at the application layer, see models.js
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
