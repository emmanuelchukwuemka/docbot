// Wrapper around the Anthropic Claude API for the two AI-layer jobs the PRD (section 25)
// calls for: entity/intent extraction from a free-text message, and grounded FAQ answering.
//
// Both methods degrade gracefully to a rule-based fallback when ANTHROPIC_API_KEY isn't
// set, so the rest of the bot is runnable/testable without a live API key.

import Anthropic from "@anthropic-ai/sdk";
import { settings } from "../config.js";
import { logger } from "../logger.js";
import { SYSTEM_PROMPT } from "./guardrails.js";

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
  name: "extract_migration_entities",
  description:
    "Extract structured migration-related entities and classify intent from a " +
    "WhatsApp message sent to a migration guidance bot.",
  input_schema: {
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
      wants_human_agent: { type: "boolean" },
      confidence: {
        type: "number",
        description: "Your confidence (0.0-1.0) that this extraction is correct and complete.",
      },
    },
    required: ["intent", "confidence", "wants_human_agent"],
  },
};

export class LLMClient {
  constructor() {
    this._client = settings.aiConfigured ? new Anthropic({ apiKey: settings.anthropicApiKey }) : null;
  }

  get configured() {
    return this._client !== null;
  }

  async extractEntities(text) {
    if (!this._client) return fallbackExtractEntities(text);

    try {
      const response = await this._client.messages.create({
        model: settings.anthropicModel,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "tool", name: "extract_migration_entities" },
        messages: [{ role: "user", content: text }],
      });
      for (const block of response.content) {
        if (block.type === "tool_use") return block.input;
      }
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
      const response = await this._client.messages.create({
        model: settings.anthropicModel,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = response.content.find((b) => b.type === "text")?.text ?? "{}";
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

/** Rule-based fallback used when no ANTHROPIC_API_KEY is configured. Deliberately
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
    wants_human_agent: intent === "human_agent",
    confidence: 0.5,
  };
}
