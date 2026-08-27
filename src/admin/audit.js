import { AuditLog } from "../db/models.js";

export async function logAction({ actor, action, targetType, targetId = null, details = {} }) {
  await AuditLog.create({ actor, action, target_type: targetType, target_id: targetId, details });
}
