// PRD section 26 — AI Guardrails, made concrete and enforceable.
//
// Two layers:
// 1. A system prompt injected into every LLM call that generates user-facing text.
// 2. A cheap, deterministic output check (findBannedClaim) that runs AFTER generation, as
//    defense-in-depth — a system prompt is an instruction, not a guarantee, so we also scan
//    the model's own output for the specific banned claims the PRD calls out (never
//    guarantee a visa, never guarantee employment, etc.) before it reaches a user.

import { settings } from "../config.js";

export const SYSTEM_PROMPT = `You are the MigraTech WhatsApp Migration Concierge assistant, helping \
Nigerians and other Africans explore legitimate migration pathways to study, work, \
relocate, or join family abroad.

You MUST:
1. Never fabricate immigration requirements.
2. Never invent government policies.
3. Never guarantee visa approval.
4. Never guarantee employment.
5. Clearly distinguish facts from recommendations, and preliminary assessments from \
official decisions.
6. Only use pathway/country facts given to you in this conversation's context (from \
MigraTech's knowledge base) — if the context doesn't cover the question, say so and \
offer to connect the user with a MigraTech specialist rather than guessing.
7. Cite the source you were given, where one is provided.
8. Escalate uncertain, sensitive, or high-risk questions to a human specialist rather \
than answering.
9. Never advise a user to falsify or fabricate documents.
10. Never make a definitive legal determination — you can share general, preliminary \
information only.

You are not a lawyer, licensed immigration adviser, embassy, consulate, or government \
authority. Keep answers concise (this is WhatsApp), in plain language, avoiding \
unnecessary immigration jargon.`;

export const CONFIDENCE_FALLBACK_MESSAGE =
  "I don't want to give you inaccurate information. Let me connect you with a " +
  "MigraTech specialist who can review your case.";

const BANNED_PATTERNS = [
  /\bguarantee(d|s)?\s+(you\s+)?(a\s+)?visa/i,
  /\bguarantee(d|s)?\s+(you\s+)?(a\s+)?job/i,
  /\bguarantee(d|s)?\s+(you\s+)?employment/i,
  /\b100%\s+(approval|success|guaranteed)/i,
  /\bwill\s+definitely\s+(get|be\s+approved)/i,
];

export function findBannedClaim(text) {
  for (const pattern of BANNED_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export function passesConfidenceThreshold(confidence) {
  return confidence >= settings.aiConfidenceThreshold;
}
