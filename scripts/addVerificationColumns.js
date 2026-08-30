// One-off migration: adds is_verified/reset_code_hash/reset_code_expires_at to `users`, for
// WhatsApp-OTP-based registration verification and password reset (see db/models.js).
//
// Grandfathers in every existing portal account (any row that already has a password_hash)
// as verified — these people already proved they control that WhatsApp number by messaging
// the bot and/or successfully logging in before this feature existed; they shouldn't get
// locked out retroactively.
//
// Idempotent — safe to run more than once.
//
// Usage: node scripts/addVerificationColumns.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

const NEW_COLUMNS = {
  is_verified: "TINYINT(1) NOT NULL DEFAULT 0",
  reset_code_hash: "VARCHAR(255) NULL",
  reset_code_expires_at: "DATETIME NULL",
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

  const [result] = await sequelize.query(
    "UPDATE users SET is_verified = 1 WHERE password_hash IS NOT NULL AND is_verified = 0"
  );
  console.log(`Grandfathered ${result.affectedRows ?? "existing"} already-registered accounts as verified.`);

  console.log("Migration complete.");
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
