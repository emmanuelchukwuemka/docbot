// Shared, pure helper used by both the Relocate menu's stage-aware hint
// (conversation/manager.js's _relocateStageHint) and the proactive reminder cron
// (scheduler.js's runRelocateCaseReminders) -- one real signal of "what's the single most
// urgent thing on this case right now", derived entirely from the actual document checklist.
// Never fabricates an item; returns null when there's genuinely nothing outstanding.

import { generateChecklist } from "../documents/checklist.js";

export function findRelocateUrgentItem(application, documents, pathway) {
  if (!pathway) return null;

  const checklist = generateChecklist(pathway, documents);
  const expired = checklist.items.find((i) => i.status === "expired");
  if (expired) return { kind: "expired_document", name: expired.name };

  const inconsistent = checklist.items.find((i) => i.status === "inconsistent");
  if (inconsistent) return { kind: "inconsistent_document", name: inconsistent.name, notes: inconsistent.review_notes };

  const missing = checklist.items.filter((i) => i.status === "missing");
  if (missing.length) return { kind: "missing_documents", names: missing.map((i) => i.name) };

  return null;
}
