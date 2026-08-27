// FR-07 Document Checklist Generator.
//
// Checklists are read straight off the pathway's `documents` field in the knowledge base
// (FR-06) — this module is deliberately thin.

const STATUS_EMOJI = {
  missing: "⬜",
  uploaded: "🟡",
  under_review: "🟡",
  verified: "✅",
  rejected: "🔴",
};

export function renderChecklistWhatsappText(checklist) {
  const lines = [`${checklist.country_name} ${checklist.pathway_name} — Preliminary Document Checklist`, ""];
  for (const item of checklist.items) {
    lines.push(`${STATUS_EMOJI[item.status] || "⬜"} ${item.name}`);
  }
  lines.push("");
  lines.push(
    "This is a preliminary list — a MigraTech specialist will confirm exactly " +
      "what's required for your case."
  );
  return lines.join("\n");
}

export function generateChecklist(pathway, existingDocuments = []) {
  const uploadedByType = {};
  for (const doc of existingDocuments) {
    uploadedByType[doc.document_type.toLowerCase()] = doc.status;
  }

  const items = (pathway.documents || []).map((docName) => ({
    name: docName,
    status: uploadedByType[docName.toLowerCase()] || "missing",
  }));

  return {
    pathway_name: pathway.name,
    country_name: pathway.country.name,
    items,
  };
}
