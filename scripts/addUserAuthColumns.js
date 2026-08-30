// One-off migration: adds password_hash/country/state to the `users` table, for the new
// web self-service portal (register/login/dashboard — see src/portal/). Deliberately NOT
// done via sequelize.sync({alter:true}) — see db/models.js's syncModels() note for why
// that's banned against this table (it silently emptied production data once, 2026-08-22).
//
// Idempotent — safe to run more than once; only adds whichever of the three columns are
// actually missing.
//
// Usage: node scripts/addUserAuthColumns.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

const NEW_COLUMNS = {
  password_hash: "VARCHAR(255) NULL",
  country: "VARCHAR(120) NULL",
  state: "VARCHAR(120) NULL",
};

async function main() {
  await connectDb();
  const qi = sequelize.getQueryInterface();
  const existing = await qi.describeTable("users");

  for (const [name, ddl] of Object.entries(NEW_COLUMNS)) {
    if (existing[name]) {
      console.log(`Column users.${name} already exists — skipping.`);
      continue;
    }
    console.log(`Adding column users.${name} ${ddl}...`);
    await sequelize.query(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`);
    console.log("  done.");
  }

  console.log("Migration complete.");
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
