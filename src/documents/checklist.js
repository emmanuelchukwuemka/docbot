// FR-07 Document Checklist Generator.
//
// Checklists are read straight off the pathway's `documents` field in the knowledge base
// (FR-06) — this module is deliberately thin.

const STATUS_EMOJI = {
  missing: "⬜",
  declared: "🔵",
  uploaded: "🟡",
  under_review: "🟡",
  verified: "✅",
  rejected: "🔴",
  expired: "⚠️",
  inconsistent: "🟠",
};

export function renderChecklistWhatsappText(checklist) {
  const lines = [`${checklist.country_name} ${checklist.pathway_name} — Preliminary Document Checklist`, ""];
  for (const item of checklist.items) {
    let line = `${STATUS_EMOJI[item.status] || "⬜"} ${item.name}`;
    // verification_status/verified_by were already real columns on Document, just never
    // surfaced here — distinguishing "uploaded, awaiting review" from "verified by staff"
    // without inventing any new tier the data doesn't actually support. "declared" is a real
    // third tier (the person says they have it, hasn't uploaded yet) -- useful for staff to
    // see before chasing someone, not a claim that anything's actually been received.
    if (item.status === "verified" && item.verified_by) line += ` — verified by ${item.verified_by}`;
    else if (item.status === "uploaded") line += " — awaiting review";
    else if (item.status === "rejected") line += " — needs resubmission";
    else if (item.status === "declared") line += " — have it, not uploaded yet";
    // expired/inconsistent are real, staff-set outcomes (reviewDocument) — never
    // auto-detected (no reliable automated signal exists for either).
    else if (item.status === "expired") line += " — expired, needs to be renewed/resubmitted";
    else if (item.status === "inconsistent") line += " — needs resubmission";
    if ((item.status === "inconsistent" || item.status === "rejected") && item.review_notes) {
      line += ` (${item.review_notes})`;
    }
    lines.push(line);
  }
  lines.push("");
  lines.push(
    "This is a preliminary list — a MigraTech specialist will confirm exactly " +
      "what's required for your case."
  );
  return lines.join("\n");
}

export function generateChecklist(pathway, existingDocuments = []) {
  const byType = {};
  for (const doc of existingDocuments) {
    byType[doc.document_type.toLowerCase()] = doc;
  }

  const items = (pathway.documents || []).map((docName) => {
    const doc = byType[docName.toLowerCase()];
    return {
      name: docName,
      status: doc ? doc.status : "missing",
      verification_status: doc ? doc.verification_status : null,
      verified_by: doc ? doc.verified_by : null,
      expiry_date: doc ? doc.expiry_date : null,
      review_notes: doc ? doc.review_notes : null,
    };
  });

  return {
    pathway_name: pathway.name,
    country_name: pathway.country.name,
    items,
  };
}
