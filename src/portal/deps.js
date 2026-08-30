import { User } from "../db/models.js";

export const SESSION_KEY = "user_id";
// Set right after register/login for an account that hasn't completed WhatsApp-OTP
// verification yet — deliberately a *different* key from SESSION_KEY, so a half-verified
// account can never accidentally satisfy getSessionUser()/requireLogin() and reach the
// dashboard before proving they actually control that WhatsApp number.
export const PENDING_VERIFY_SESSION_KEY = "pending_verify_user_id";

/** Returns the logged-in portal User for this request's session, or null — never throws.
 * Mirrors admin/deps.js's getSessionAdminUser, but for customer accounts: a distinct session
 * key on the same session object (see server.js) so a staff member and a customer logged in
 * from the same browser don't collide. */
export async function getSessionUser(req) {
  const userId = req.session?.[SESSION_KEY];
  if (!userId) return null;
  const user = await User.findByPk(userId);
  // No password_hash means either this row was never a real portal account (just a WhatsApp
  // contact the bot created) or the account was deleted/cleared — either way, not logged in.
  // is_verified check is defense-in-depth — SESSION_KEY should never be set for an
  // unverified account in the first place (see routes.js), but a request shouldn't trust a
  // stale/tampered cookie over the DB's own record of verification state.
  if (!user || !user.password_hash || !user.is_verified) return null;
  return user;
}

export async function requireLogin(req, res, next) {
  const user = await getSessionUser(req);
  if (!user) return res.redirect(303, "/login");
  req.portalUser = user;
  next();
}

/** The account this session is mid-OTP-flow for (registration verification OR password
 * reset — the same key/mechanism serves both, see routes.js), or null. Deliberately does
 * NOT check is_verified — that would break password reset for every already-verified
 * account, which is most real users; found exactly this bug while testing. Callers that
 * care about verification state specifically (the /verify routes) check it themselves. */
export async function getPendingVerifyUser(req) {
  const userId = req.session?.[PENDING_VERIFY_SESSION_KEY];
  if (!userId) return null;
  const user = await User.findByPk(userId);
  if (!user || !user.password_hash) return null;
  return user;
}
