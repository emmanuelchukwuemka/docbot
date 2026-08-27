import { AdminUser } from "../db/models.js";

export const SESSION_KEY = "admin_user_id";

/** Returns the logged-in AdminUser for this request's session, or null — never throws.
 * Page routes use this to decide whether to redirect to /admin/login; the middleware below
 * builds 401/403s on top of it. */
export async function getSessionAdminUser(req) {
  const userId = req.session?.[SESSION_KEY];
  if (!userId) return null;
  const user = await AdminUser.findByPk(userId);
  if (!user || !user.is_active) return null;
  return user;
}

/** Any active staff account (admin or agent) — use for the JSON API. */
export async function requireAdmin(req, res, next) {
  const user = await getSessionAdminUser(req);
  if (!user) return res.status(401).json({ detail: "Not logged in" });
  req.adminUser = user;
  next();
}

/** `admin` role only — use for knowledge-base edits and staff-account management. */
export function requireAdminRole(req, res, next) {
  if (req.adminUser.role !== "admin") return res.status(403).json({ detail: "Requires admin role" });
  next();
}
