import bcrypt from "bcryptjs";

export function hashPassword(password) {
  return bcrypt.hashSync(password, 12);
}

export function verifyPassword(password, passwordHash) {
  try {
    return bcrypt.compareSync(password, passwordHash);
  } catch {
    return false;
  }
}
