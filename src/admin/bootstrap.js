// Seeds a first `admin`-role AdminUser from ADMIN_USERNAME/ADMIN_PASSWORD on startup, so a
// fresh install has a working login without a manual step. Real staff accounts should be
// created via scripts/createAdminUser.js — this only ever creates the one seed account.

import { settings } from "../config.js";
import { logger } from "../logger.js";
import { AdminUser } from "../db/models.js";
import { hashPassword } from "../security/passwords.js";

export async function ensureDefaultAdmin() {
  const count = await AdminUser.count();
  if (count > 0) return;

  await AdminUser.create({
    username: settings.adminUsername,
    password_hash: hashPassword(settings.adminPassword),
    role: "admin",
  });
  logger.info({ username: settings.adminUsername }, "Seeded default admin user from ADMIN_USERNAME/ADMIN_PASSWORD.");
}
