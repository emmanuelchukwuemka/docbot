// FR-11 Human Handoff — escalation trigger detection.
//
// Deliberately narrow scope (business decision, 2026-08-28): the bot no longer hands off for
// routine friction — a user seeming confused/repeatedly failing an automated flow, or a bare
// "let me talk to a human" with no stated reason, or the AI being unsure how to answer a
// question. It just keeps trying to help. The triggers below are the ones that stay: genuine
// safety/liability situations the PRD explicitly calls out (fraud, legal questions, visa
// refusals, immigration violations, sensitive family circumstances, document concerns) plus
// an explicit complaint. Everything else only ever hands off via the payment gate (see
// conversation/manager.js's _requireTier) or a staff member manually taking over in the
// admin dashboard.

const LEGAL_KEYWORDS = /\b(lawyer|legal advice|sue|solicitor|barrister)\b/i;
const REFUSAL_KEYWORDS = /\b(refus(ed|al)|denied|rejection)\b/i;
const VIOLATION_KEYWORDS = /\b(overstay(ed)?|deported|deportation|violat(ed|ion)|banned|ban from)\b/i;
const FRAUD_REPORT_KEYWORDS = /\b(scammed|scam|fraud|fake agent|fake visa|fake job offer)\b/i;
const SENSITIVE_FAMILY_KEYWORDS =
  /\b(domestic violence|abusive relationship|custody (battle|dispute|case)|estranged|passed away|deceased|death of my|divorce|separated from my (spouse|husband|wife))\b/i;
const DOCUMENT_CONCERN_KEYWORDS =
  /\b(lost my passport|passport (was |got )?stolen|expired passport|document(s)? (was |were |got )?rejected|can'?t (find|get|obtain) my (document|certificate|passport|degree))\b/i;

export const ESCALATION_MESSAGE =
  "This case requires a MigraTech specialist. I'll connect you with a member of our team.";

export const FRAUD_WARNING_MESSAGE =
  "⚠️ A reminder: MigraTech will never ask you to pay government fees into a personal " +
  "bank account, guarantee you a visa, or promise a job without a real interview " +
  "process. Watch out for fake job offers, fake visa guarantees, fake immigration " +
  "officers, and fake embassy messages. Thank you for flagging this — a member of our " +
  "team will follow up with you.";

export function detectEscalationReason(text, extracted) {
  if (extracted && extracted.intent === "complaint") {
    return "Complaint detected.";
  }
  if (LEGAL_KEYWORDS.test(text)) {
    return "Complex immigration/legal question.";
  }
  if (REFUSAL_KEYWORDS.test(text)) {
    return "Possible prior visa refusal mentioned.";
  }
  if (VIOLATION_KEYWORDS.test(text)) {
    return "Possible previous immigration violation mentioned — sensitive, needs human review.";
  }
  if (FRAUD_REPORT_KEYWORDS.test(text)) {
    return "User reporting suspicious/fraudulent activity (FR-16).";
  }
  if (SENSITIVE_FAMILY_KEYWORDS.test(text)) {
    return "Sensitive family circumstances mentioned — needs human review.";
  }
  if (DOCUMENT_CONCERN_KEYWORDS.test(text)) {
    return "Document concern raised (lost/stolen/rejected) — needs human review.";
  }
  return null;
}
