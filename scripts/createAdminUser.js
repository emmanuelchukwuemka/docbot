// Create (or update) a MigraTech admin-dashboard staff account.
//
// Usage: node scripts/createAdminUser.js <username> <password> [--role admin|agent]

import { connectDb, sequelize } from "../src/db/sequelize.js";
import { AdminUser } from "../src/db/models.js";
import { hashPassword } from "../src/security/passwords.js";

async function main() {
  const args = process.argv.slice(2);
  const roleIdx = args.indexOf("--role");
  const role = roleIdx !== -1 ? args[roleIdx + 1] : "agent";
  const positional = args.filter((a, i) => i !== roleIdx && i !== roleIdx + 1 && !a.startsWith("--"));
  const [username, password] = positional;

  if (!username || !password) {
    console.error("Usage: node scripts/createAdminUser.js <username> <password> [--role admin|agent]");
    process.exit(1);
  }
  if (!["admin", "agent"].includes(role)) {
    console.error("--role must be 'admin' or 'agent'");
    process.exit(1);
  }

  await connectDb();

  let user = await AdminUser.findOne({ where: { username } });
  if (user) {
    user.password_hash = hashPassword(password);
    user.role = role;
    user.is_active = true;
    await user.save();
    console.log(`Updated existing staff account '${username}' (role=${role}).`);
  } else {
    await AdminUser.create({ username, password_hash: hashPassword(password), role });
    console.log(`Created staff account '${username}' (role=${role}).`);
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
