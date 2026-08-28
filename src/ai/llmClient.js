// Wrapper around the OpenAI API for the two AI-layer jobs the PRD (section 25)
// calls for: entity/intent extraction from a free-text message, and grounded FAQ answering.
//
// Both methods degrade gracefully to a rule-based fallback when OPENAI_API_KEY isn't
// set, so the rest of the bot is runnable/testable without a live API key.

import OpenAI from "openai";
import { settings } from "../config.js";
import { logger } from "../logger.js";
import { SYSTEM_PROMPT } from "./guardrails.js";
import { RateLimiter } from "../security/rateLimiter.js";

// Module-level (not per-instance) so every LLMClient shares one budget — matches how
// ConversationManager actually uses this in practice (see manager.js), and means the cap
// holds even if something ever constructs more than one LLMClient.
export const aiRateLimiter = new RateLimiter({
  max: settings.aiRateLimitMax,
  windowMs: settings.aiRateLimitWindowMs,
});

export const INTENTS = [
  "migration_enquiry",
  "eligibility_assessment",
  "work",
  "study",
  "family",
  "cost",
  "documents",
  "application_status",
  "consultation",
  "complaint",
  "human_agent",
  "faq",
  "other",
];

const EXTRACTION_TOOL = {
  type: "function",
  function: {
    name: "extract_migration_entities",
    description:
      "Extract structured migration-related entities and classify intent from a " +
      "WhatsApp message sent to a migration guidance bot.",
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", enum: INTENTS },
        destination_country: { type: ["string", "null"] },
        migration_objective: {
          type: ["string", "null"],
          enum: ["work", "study", "family", "business", "visit", "unsure", null],
        },
        occupation: { type: ["string", "null"] },
        education: { type: ["string", "null"] },
        experience_years: { type: ["integer", "null"] },
        age: { type: ["integer", "null"] },
        language_ability: { type: ["string", "null"] },
        family_status: { type: ["string", "null"] },
        timeline: {
          type: ["string", "null"],
          enum: ["within_3_months", "3_6_months", "6_12_months", "more_than_12_months", null],
        },
        budget: {
          type: ["string", "null"],
          description: "The user's stated budget or financial readiness for migration costs, if " +
            "mentioned (free text, e.g. '₦2 million' or 'not sure yet').",
        },
        wants_human_agent: {
          type: "boolean",
          description: "True ONLY if the user explicitly asked to speak with a human, agent, " +
            "or specialist (e.g. 'let me talk to someone', 'I want a real person'). Do NOT set " +
            "this true just because the message is about migration, work, study, family, or any " +
            "other topic — those are exactly what the bot itself should help with, not escalate.",
        },
        confidence: {
          type: "number",
          description: "Your confidence (0.0-1.0) that this extraction is correct and complete.",
        },
      },
      required: ["intent", "confidence", "wants_human_agent"],
    },
  },
};

export class LLMClient {
  constructor() {
    this._client = settings.aiConfigured ? new OpenAI({ apiKey: settings.openaiApiKey }) : null;
  }

  get configured() {
    return this._client !== null;
  }

  async extractEntities(text) {
    if (!this._client) return fallbackExtractEntities(text);
    if (!aiRateLimiter.consume()) {
      logger.warn("AI rate limit hit — falling back to rule-based extraction for this message.");
      return fallbackExtractEntities(text);
    }

    try {
      const response = await this._client.chat.completions.create({
        model: settings.openaiModel,
        max_tokens: 512,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "function", function: { name: "extract_migration_entities" } },
      });
      const toolCall = response.choices[0]?.message?.tool_calls?.[0];
      if (toolCall) return JSON.parse(toolCall.function.arguments);
    } catch (err) {
      logger.error({ err }, "LLM entity extraction failed, falling back to rule-based extraction");
    }
    return fallbackExtractEntities(text);
  }

  /** Returns {answer, confidence}. Falls back to returning the best matching snippet
   * verbatim (with reduced confidence) when the LLM isn't configured. */
  async answerGrounded(question, contextSnippets) {
    if (!contextSnippets.length) {
      return {
        answer:
          "I don't have verified information on that yet. Let me connect you " +
          "with a MigraTech specialist who can help.",
        confidence: 0.0,
      };
    }

    if (!this._client) {
      return { answer: contextSnippets[0], confidence: 0.5 };
    }
    if (!aiRateLimiter.consume()) {
      logger.warn("AI rate limit hit — returning best matching snippet without a live LLM call.");
      return { answer: contextSnippets[0], confidence: 0.5 };
    }

    const contextBlock = contextSnippets.map((s) => `- ${s}`).join("\n\n");
    const prompt =
      `A user asked: "${question}"\n\n` +
      `Here is MigraTech's verified knowledge base context relevant to this question:\n` +
      `${contextBlock}\n\n` +
      "Answer the user's question using ONLY the context above, in 1-3 short " +
      "sentences suitable for WhatsApp. Respond with a JSON object with keys " +
      '"answer" (string) and "confidence" (0.0-1.0, how well the context actually ' +
      'answers the question). If the context doesn\'t really answer it, say so in ' +
      '"answer" and set confidence low.';

    try {
      const response = await this._client.chat.completions.create({
        model: settings.openaiModel,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      });
      const textBlock = response.choices[0]?.message?.content ?? "{}";
      const data = JSON.parse(textBlock);
      return {
        answer: data.answer ?? contextSnippets[0],
        confidence: Number(data.confidence ?? 0.5),
      };
    } catch (err) {
      logger.error({ err }, "LLM grounded answer failed, falling back to raw snippet");
      return { answer: contextSnippets[0], confidence: 0.4 };
    }
  }
}

/** Rule-based fallback used when no OPENAI_API_KEY is configured. Deliberately
 * conservative confidence so downstream code (see ai/nlu.js) tends to escalate rather
 * than act on a shaky guess. */
function fallbackExtractEntities(text) {
  const lowered = text.toLowerCase();

  let intent = "other";
  if (["human", "agent", "specialist", "person", "talk to someone"].some((w) => lowered.includes(w))) {
    intent = "human_agent";
  } else if (["complain", "complaint", "unhappy", "issue with"].some((w) => lowered.includes(w))) {
    intent = "complaint";
  } else if (["cost", "fee", "price", "how much"].some((w) => lowered.includes(w))) {
    intent = "cost";
  } else if (["document", "checklist", "paperwork"].some((w) => lowered.includes(w))) {
    intent = "documents";
  } else if (["track", "status", "application"].some((w) => lowered.includes(w))) {
    intent = "application_status";
  } else if (["study", "school", "university", "master", "phd", "undergraduate"].some((w) => lowered.includes(w))) {
    intent = "study";
  } else if (["work", "job", "employ"].some((w) => lowered.includes(w))) {
    intent = "work";
  } else if (["family", "spouse", "husband", "wife", "children", "reunite"].some((w) => lowered.includes(w))) {
    intent = "family";
  } else if (["migrat", "relocate", "move to", "abroad"].some((w) => lowered.includes(w))) {
    intent = "migration_enquiry";
  }

  let objective = null;
  if (["work", "study", "family"].includes(intent)) objective = intent;

  return {
    intent,
    destination_country: null,
    migration_objective: objective,
    occupation: null,
    education: null,
    experience_years: null,
    age: null,
    language_ability: null,
    family_status: null,
    timeline: null,
    budget: null,
    wants_human_agent: intent === "human_agent",
    confidence: 0.5,
  };
}
