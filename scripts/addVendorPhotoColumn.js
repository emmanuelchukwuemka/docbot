// One-off migration: adds the `photo_url` column to the `vendors` table (2026-09-01,
// user-directed: agents should be able to upload a profile picture). Same reasoning as
// scripts/addVendorIdColumn.js — `vendors` already exists on production (created by the
// previous deploy of this same feature), and sequelize.sync() without {alter:true} never
// adds columns to a table that already exists.
//
// Does NOT touch the new `vendor_documents` table — that one is brand new, so
// sequelize.sync() (which production runs on every boot, see server.js) creates it
// correctly on its own; only this new column on a pre-existing table needs the explicit path.
//
// Idempotent — safe to run more than once.
//
// Usage: node scripts/addVendorPhotoColumn.js

import { connectDb, sequelize } from "../src/db/sequelize.js";

async function main() {
  await connectDb();
  const qi = sequelize.getQueryInterface();
  const existing = await qi.describeTable("vendors");

  if (existing.photo_url) {
    console.log("Column vendors.photo_url already exists — skipping.");
  } else {
    console.log("Adding column vendors.photo_url VARCHAR(500) NULL...");
    await sequelize.query("ALTER TABLE vendors ADD COLUMN photo_url VARCHAR(500) NULL");
    console.log("  done.");
  }

  console.log("Migration complete.");
  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
