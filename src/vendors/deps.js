// Session handling for the partner-agent dashboard. A distinct session key on the same
// session object (see server.js) — same pattern as admin/deps.js and portal/deps.js — so a
// staff member, a customer, and a vendor logged in from the same browser never collide.

import { Vendor } from "../db/models.js";

export const VENDOR_SESSION_KEY = "vendor_id";

/** Returns the logged-in Vendor for this request's session, or null — never throws.
 * status !== "approved" always fails this, even with a valid session cookie — an applicant
 * whose account was later rejected/suspended must be logged out immediately, not just
 * blocked from future logins. See db/models.js's Vendor definition for why that gate is
 * load-bearing, not incidental. */
export async function getSessionVendor(req) {
  const vendorId = req.session?.[VENDOR_SESSION_KEY];
  if (!vendorId) return null;
  const vendor = await Vendor.findByPk(vendorId);
  if (!vendor || vendor.status !== "approved") return null;
  return vendor;
}

export async function requireVendorLogin(req, res, next) {
  const vendor = await getSessionVendor(req);
  if (!vendor) return res.redirect(303, "/agents/login");
  req.vendor = vendor;
  next();
}
