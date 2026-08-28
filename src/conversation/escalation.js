// FR-11 Human Handoff — escalation trigger detection.
//
// Deterministic (keyword + structured-field) triggers only. AI-confidence-based escalation
// (the "I don't want to give you inaccurate information..." fallback) is handled separately
// in the AI layer (see ai/guardrails.js) since it depends on a specific LLM call's
// self-reported confidence, not on the raw inbound text.

export const FALLBACK_ESCALATION_THRESHOLD = 2;

const LEGAL_KEYWORDS = /\b(lawyer|legal advice|sue|solicitor|barrister)\b/i;
const REFUSAL_KEYWORDS = /\b(refus(ed|al)|denied|rejection)\b/i;
const VIOLATION_KEYWORDS = /\b(overstay(ed)?|deported|deportation|violat(ed|ion)|banned|ban from)\b/i;
const FRAUD_REPORT_KEYWORDS = /\b(scammed|scam|fraud|fake agent|fake visa|fake job offer)\b/i;
const SENSITIVE_FAMILY_KEYWORDS =
  /\b(domestic violence|abusive relationship|custody (battle|dispute|case)|estranged|passed away|deceased|death of my|divorce|separated from my (spouse|husband|wife))\b/i;
const DOCUMENT_CONCERN_KEYWORDS =
  /\b(lost my passport|passport (was |got )?stolen|expired passport|document(s)? (was |were |got )?rejected|can'?t (find|get|obtain) my (document|certificate|passport|degree))\b/i;
// Deliberately narrower than "any mention of a specialist/someone" — those words now
// collide with legitimate consultation-flow menu options ("Speak to a specialist"), which
// must reach ConversationManager's offerConsultation instead of being hard-escalated by
// this top-of-turn check. Organic free-text phrasing like "let me speak to a specialist"
// outside a menu context is still caught by the AI NLU fallback's intent="human_agent"
// classification, which runs after menu-option matching fails.
const HUMAN_REQUEST_KEYWORDS = /\b(human|real person|talk to (an?\s+)?agent|speak to (an?\s+)?(agent|human))\b/i;

export const ESCALATION_MESSAGE =
  "This case requires a MigraTech specialist. I'll connect you with a member of our team.";

export const FRAUD_WARNING_MESSAGE =
  "⚠️ A reminder: MigraTech will never ask you to pay government fees into a personal " +
  "bank account, guarantee you a visa, or promise a job without a real interview " +
  "process. Watch out for fake job offers, fake visa guarantees, fake immigration " +
  "officers, and fake embassy messages. Thank you for flagging this — a member of our " +
  "team will follow up with you.";

export function detectEscalationReason(text, extracted, fallbackCount, { checkFallbackThreshold = true } = {}) {
  if ((extracted && extracted.wants_human_agent) || HUMAN_REQUEST_KEYWORDS.test(text)) {
    return "User requested a human agent.";
  }
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
  if (checkFallbackThreshold && fallbackCount >= FALLBACK_ESCALATION_THRESHOLD) {
    return "User is confused or has repeatedly failed an automated flow.";
  }
  return null;
}
