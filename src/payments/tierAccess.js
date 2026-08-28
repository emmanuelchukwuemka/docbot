// DISCOVER (free) / NAVIGATE / RELOCATE package model — see conversation/manager.js's
// _requireTier for where these gates are actually enforced.

import { Payment } from "../db/models.js";

const TIER_RANK = { navigate: 1, relocate: 2 };

/** True if `userId` has a completed payment for `tier` or a higher one — RELOCATE includes
 * everything NAVIGATE unlocks, so a paid Relocate package also satisfies a Navigate gate. */
export async function hasPaidTier(userId, tier) {
  const requiredRank = TIER_RANK[tier];
  if (!requiredRank) return true;

  const payments = await Payment.findAll({ where: { user_id: userId, status: "paid" } });
  return payments.some((p) => TIER_RANK[p.tier] >= requiredRank);
}
