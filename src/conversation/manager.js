// The conversation orchestration layer: FR-01 through FR-05, FR-07, FR-09 through FR-11,
// FR-14, FR-15 all meet here. States live on Conversation.state (a plain label) with
// transient scratch data in Conversation.context (JSON).
//
// Design note on the AI shortcut: greetings/empty text get the full welcome menu; anything
// else is run through NLU extraction, and if it yields a destination and/or goal, the
// relevant fields are saved and the user is fast-forwarded past questions already answered.

import { randomUUID } from "node:crypto";
import { settings } from "../config.js";
import { logger } from "../logger.js";
import { logAction } from "../admin/audit.js";
import { CONFIDENCE_FALLBACK_MESSAGE, findBannedClaim, passesConfidenceThreshold } from "../ai/guardrails.js";
import { LLMClient } from "../ai/llmClient.js";
import { understand } from "../ai/nlu.js";
import * as flows from "./flows.js";
import { ESCALATION_MESSAGE, FRAUD_WARNING_MESSAGE, detectEscalationReason } from "./escalation.js";
import {
  Application,
  ConsultationBooking,
  Conversation,
  Country,
  Document,
  EligibilityAssessment,
  Lead,
  Message,
  MigrationProfile,
  Pathway,
  Payment,
  User,
} from "../db/models.js";
import { generateChecklist, renderChecklistWhatsappText } from "../documents/checklist.js";
import { LocalEncryptedStorage } from "../documents/storage.js";
import { assess } from "../eligibility/engine.js";
import { getPathwaysForCountry, searchFaqs, searchPathways } from "../knowledgeBase/service.js";
import { scoreLead } from "../leads/scoring.js";
import { initializeTransaction } from "../payments/paystackClient.js";
import { hasPaidTier } from "../payments/tierAccess.js";

export const APPLICATION_STAGE_ORDER = [
  "profile_assessment",
  "pathway_selection",
  "documents",
  "expert_review",
  "application_preparation",
  "submission",
  "decision",
];
export const APPLICATION_STAGE_LABELS = {
  profile_assessment: "Profile Assessment",
  pathway_selection: "Pathway Selection",
  documents: "Documents",
  expert_review: "Expert Review",
  application_preparation: "Application Preparation",
  submission: "Submission",
  decision: "Decision",
};

const FRAUD_EDUCATION_TIP =
  "🛡️ Reminder: legitimate migration never requires paying government fees into a " +
  "personal bank account, and no one can guarantee visa approval — watch out for " +
  "anyone who claims otherwise.";

const WELCOME_TEXT =
  "Welcome to MigraTech 👋\n\n" +
  "I can help you explore legitimate migration options for work, study, family " +
  "relocation and more.\n\n" +
  "This is general guidance, not a visa guarantee — official decisions are made only " +
  "by the relevant government/immigration authority. By continuing, you agree to " +
  "MigraTech processing your information to provide this guidance (reply STOP anytime " +
  "to opt out).";

const STOP_KEYWORDS = new Set(["stop", "unsubscribe", "opt out", "optout"]);
const DELETE_DATA_KEYWORDS = new Set(["delete my data", "delete data", "delete my account"]);
const CONFIRM_DELETE_PHRASE = "CONFIRM DELETE";
const ASSESSMENT_MENU_OPTIONS = ["Check required documents", "Speak to a specialist", "Back to main menu"];

const SUGGESTED_COUNTRIES_BY_PRIORITY = {
  "Employment opportunities": ["Canada", "Germany"],
  Education: ["Germany"],
  "Permanent residency prospects": ["Canada"],
  "Family relocation": ["United Kingdom"],
  "Lower migration cost": ["Germany"],
  "Faster processing": ["Canada"],
  "Higher earning potential": ["Canada", "United Kingdom"],
  "Business opportunities": ["Canada"],
};

const GREETING_RE = /^(hi|hello|hey|good\s?(morning|afternoon|evening)|hola|start|menu)[\s!.,]*$/i;

function isGreeting(text) {
  return !text.trim() || GREETING_RE.test(text.trim());
}

function resolveSelection(text, interactiveId, options) {
  if (interactiveId && interactiveId.startsWith("opt_")) {
    const idx = parseInt(interactiveId.slice(4), 10);
    if (!Number.isNaN(idx) && idx >= 0 && idx < options.length) return idx;
  }

  const stripped = text.trim();
  if (/^\d+$/.test(stripped)) {
    const idx = parseInt(stripped, 10) - 1;
    if (idx >= 0 && idx < options.length) return idx;
  }

  const lowered = stripped.toLowerCase();
  for (let i = 0; i < options.length; i++) {
    const optionLower = options[i].toLowerCase();
    if (optionLower === lowered || (lowered && optionLower.includes(lowered))) return i;
  }
  return null;
}

export class ConversationManager {
  constructor({ whatsappClient, llmClient = null } = {}) {
    this.whatsappClient = whatsappClient;
    this.llmClient = llmClient || new LLMClient();
  }

  // ------------------------------------------------------------------ //
  // Entry point
  // ------------------------------------------------------------------ //

  async handleInbound(user, conversation, text, interactiveId) {
    if (!user.consent_given) {
      user.consent_given = true;
      user.consent_at = new Date();
      await user.save();
    }

    const lowered = text.trim().toLowerCase();

    if (STOP_KEYWORDS.has(lowered)) {
      conversation.state = "ended";
      await conversation.save();
      await this._send(user, conversation, "You've been unsubscribed from MigraTech updates. Message us anytime to restart.");
      return;
    }

    if (DELETE_DATA_KEYWORDS.has(lowered)) {
      conversation.state = "confirm_deletion";
      await conversation.save();
      await this._send(
        user, conversation,
        "This will permanently delete your MigraTech profile, conversation " +
          "history, documents, and lead record — this cannot be undone. Reply " +
          `"${CONFIRM_DELETE_PHRASE}" to proceed, or anything else to cancel.`
      );
      return;
    }

    if (conversation.escalation_status === "in_progress") {
      // Staff have actively taken this conversation over (resolveConversation/
      // sendStaffMessage in admin/service.js) — stay quiet so we don't talk over them.
      // Deliberately NOT triggered by "requested" — an automatically-detected escalation
      // trigger flags the conversation for staff and keeps the bot talking; only an
      // explicit staff action stops it.
      return;
    }

    if (conversation.state === "awaiting_payment_email") {
      await this._handleAwaitingPaymentEmail(user, conversation, text);
      return;
    }
    if (conversation.state === "awaiting_payment") {
      await this._handleAwaitingPayment(user, conversation, text);
      return;
    }

    if (await this._maybeEscalate(user, conversation, text, null)) return;

    const handlers = {
      welcome: this._handleWelcome,
      main_menu: this._handleMainMenu,
      goal_selection: this._handleGoalSelection,
      destination_discovery: this._handleDestinationDiscovery,
      collecting: this._handleCollecting,
      assessment_menu: this._handleAssessmentMenu,
      faq_waiting_question: this._handleFaqWaitingQuestion,
      consultation_menu: this._handleConsultationMenu,
      booking_time: this._handleBookingTime,
      booking_contact: this._handleBookingContact,
      confirm_deletion: this._handleConfirmDeletion,
      ended: this._handleWelcome,
    };
    const handler = handlers[conversation.state] || this._handleWelcome;
    await handler.call(this, user, conversation, text, interactiveId);
  }

  /** FR-08 Document Collection, entry point from the WhatsApp ingest layer for
   * document/image messages (separate from handleInbound since there's no text to run
   * through the state machine). `content` is the already-downloaded file bytes, or null if
   * the download failed. */
  async handleDocumentUpload(user, conversation, { content, mimeType, filename, whatsappMediaId }) {
    if (conversation.escalation_status === "in_progress") return;

    if (content == null) {
      await this._send(
        user, conversation,
        "I couldn't process that file just now — please try again, or a " +
          "MigraTech specialist can help you submit it another way."
      );
      return;
    }

    const storage = new LocalEncryptedStorage();
    const filePath = storage.save(user.id, filename, content);

    const documentType = await this._nextMissingDocumentType(user, conversation);
    let document = await Document.findOne({ where: { user_id: user.id, document_type: documentType, status: "missing" } });
    if (!document) document = Document.build({ user_id: user.id, document_type: documentType });
    document.file_location = filePath;
    document.original_filename = filename;
    document.mime_type = mimeType;
    document.whatsapp_media_id = whatsappMediaId;
    document.status = "uploaded";
    document.verification_status = "unreviewed";
    document.uploaded_at = new Date();
    await document.save();

    await this._send(
      user, conversation,
      `Got it — I've received your file and logged it as "${documentType}". ` +
        "A MigraTech specialist will review it."
    );
    const profile = await this._getOrCreateProfile(user);
    await this._upsertLead(user, profile, null);
  }

  async _nextMissingDocumentType(user, conversation) {
    const pathwayId = conversation.context.pathway_id;
    const pathway = pathwayId ? await Pathway.findByPk(pathwayId, { include: [{ model: Country, as: "country" }] }) : null;
    if (!pathway) return "Uploaded document";
    const documents = await Document.findAll({ where: { user_id: user.id } });
    const checklist = generateChecklist(pathway, documents);
    const missing = checklist.items.find((item) => item.status === "missing");
    return missing ? missing.name : "Additional document";
  }

  // ------------------------------------------------------------------ //
  // State handlers
  // ------------------------------------------------------------------ //

  async _handleWelcome(user, conversation, text) {
    if (isGreeting(text)) {
      await this._send(user, conversation, WELCOME_TEXT);
      await this._sendMainMenu(user, conversation);
      return;
    }
    if (!(await this._tryShortcutFromFreeText(user, conversation, text))) {
      await this._send(user, conversation, WELCOME_TEXT);
      await this._sendMainMenu(user, conversation);
    }
  }

  async _handleMainMenu(user, conversation, text, interactiveId) {
    const idx = resolveSelection(text, interactiveId, flows.MAIN_MENU_OPTIONS);
    if (idx === null) {
      if (await this._tryShortcutFromFreeText(user, conversation, text)) return;
      conversation.fallback_count += 1;
      await conversation.save();
      await this._sendMainMenu(user, conversation, "Sorry, I didn't quite catch that.");
      return;
    }

    conversation.fallback_count = 0;
    const option = flows.MAIN_MENU_OPTIONS[idx];

    if (["Explore Migration Options", "Check My Eligibility"].includes(option)) {
      conversation.state = "goal_selection";
      await conversation.save();
      await this._send(user, conversation, "What is your primary goal?", flows.GOAL_OPTIONS);
    } else if (option === "Work Abroad") {
      await this._startFlow(user, conversation, "work");
    } else if (option === "Study Abroad") {
      await this._startFlow(user, conversation, "study");
    } else if (option === "Family Migration") {
      await this._startFlow(user, conversation, "family");
    } else if (option === "Migration Costs") {
      await this._answerFaq(user, conversation, "How much does migration cost?");
      await this._sendMainMenu(user, conversation, "Anything else I can help with?");
    } else if (option === "Required Documents") {
      await this._handleDocumentsRequest(user, conversation);
    } else if (option === "Speak to an Expert") {
      await this._offerConsultation(user, conversation);
    } else if (option === "Track My Application") {
      if (await this._handleTrackApplication(user, conversation)) {
        await this._sendMainMenu(user, conversation);
      }
    } else if (option === "FAQs") {
      conversation.state = "faq_waiting_question";
      await conversation.save();
      await this._send(user, conversation, "What would you like to know?");
    } else {
      await conversation.save();
    }
  }

  async _handleGoalSelection(user, conversation, text, interactiveId) {
    const idx = resolveSelection(text, interactiveId, flows.GOAL_OPTIONS);
    if (idx === null) {
      if (await this._tryShortcutFromFreeText(user, conversation, text)) return;
      conversation.fallback_count += 1;
      await conversation.save();
      await this._send(user, conversation, "Sorry, I didn't catch that — what is your primary goal?", flows.GOAL_OPTIONS);
      return;
    }

    conversation.fallback_count = 0;
    const category = flows.GOAL_CODES[idx];
    if (category === "unsure") {
      conversation.state = "destination_discovery";
      await conversation.save();
      await this._send(user, conversation, "No problem. What is most important to you?", flows.DESTINATION_DISCOVERY_OPTIONS);
      return;
    }
    await this._startFlow(user, conversation, category);
  }

  async _handleDestinationDiscovery(user, conversation, text, interactiveId) {
    const idx = resolveSelection(text, interactiveId, flows.DESTINATION_DISCOVERY_OPTIONS);
    if (idx === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      await this._send(user, conversation, "Could you pick one of the options below?", flows.DESTINATION_DISCOVERY_OPTIONS);
      return;
    }

    conversation.fallback_count = 0;
    const priority = flows.DESTINATION_DISCOVERY_OPTIONS[idx];
    const suggestions = SUGGESTED_COUNTRIES_BY_PRIORITY[priority] || [];
    const suggestionText = suggestions.length
      ? ` Many people exploring that priority look at: ${suggestions.join(", ")}.`
      : "";
    conversation.state = "goal_selection";
    await conversation.save();
    await this._send(
      user, conversation,
      `Thanks — that helps.${suggestionText} These are starting points, not ` +
        "guarantees. What is your primary goal?",
      flows.GOAL_OPTIONS
    );
  }

  async _handleCollecting(user, conversation, text, interactiveId) {
    const profile = await this._getOrCreateProfile(user);
    const category = conversation.context.category;
    const fieldIndex = conversation.context.field_index || 0;
    const questions = flows.FLOWS[category] || [];

    if (fieldIndex >= questions.length) {
      await this._completeFlow(user, conversation, profile, category);
      return;
    }

    const q = questions[fieldIndex];
    let value = null;
    if (q.options.length) {
      const optIdx = resolveSelection(text, interactiveId, q.options);
      if (optIdx !== null) value = q.parser(q.options[optIdx]);
    }
    if (value === null) value = q.parser(text);

    if (value === null) {
      const extracted = await understand(this.llmClient, text);
      if (await this._maybeEscalate(user, conversation, text, extracted)) return;
      value = extracted[q.field_name] ?? null;
    }

    if (value === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      await this._send(user, conversation, "Sorry, I didn't quite catch that. " + q.prompt, q.options);
      return;
    }

    profile[q.field_name] = value;
    await profile.save();
    conversation.fallback_count = 0;
    await conversation.save();
    await this._askNextCollectingQuestion(user, conversation, profile, category);
  }

  async _handleAssessmentMenu(user, conversation, text, interactiveId) {
    const idx = resolveSelection(text, interactiveId, ASSESSMENT_MENU_OPTIONS);
    if (idx === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      await this._send(user, conversation, "Could you pick one of the options below?", ASSESSMENT_MENU_OPTIONS);
      return;
    }

    conversation.fallback_count = 0;
    if (idx === 0) {
      const pathwayId = conversation.context.pathway_id;
      const pathway = pathwayId ? await Pathway.findByPk(pathwayId, { include: [{ model: Country, as: "country" }] }) : null;
      if (pathway) {
        const documents = await Document.findAll({ where: { user_id: user.id } });
        const checklist = generateChecklist(pathway, documents);
        await this._send(user, conversation, renderChecklistWhatsappText(checklist), ASSESSMENT_MENU_OPTIONS);
      } else {
        await this._send(user, conversation, "I couldn't find that pathway anymore — let's start over.");
        await this._sendMainMenu(user, conversation);
      }
    } else if (idx === 1) {
      await this._offerConsultation(user, conversation);
    } else {
      await this._sendMainMenu(user, conversation);
    }
  }

  async _handleFaqWaitingQuestion(user, conversation, text) {
    if (await this._answerFaq(user, conversation, text)) {
      await this._sendMainMenu(user, conversation, "Anything else I can help with?");
    }
  }

  async _handleConsultationMenu(user, conversation, text, interactiveId) {
    const idx = resolveSelection(text, interactiveId, flows.CONSULTATION_MENU_OPTIONS);
    if (idx === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      await this._send(user, conversation, "Could you pick one of the options below?", flows.CONSULTATION_MENU_OPTIONS);
      return;
    }

    conversation.fallback_count = 0;
    if (idx === 0) {
      conversation.state = "booking_time";
      await conversation.save();
      await this._send(
        user, conversation,
        "What day/time generally works best for a call with a MigraTech " +
          'specialist? (e.g. "Tuesday afternoon" or a specific date/time)'
      );
    } else if (idx === 1) {
      await this._send(user, conversation, ESCALATION_MESSAGE);
      await this._escalate(conversation, "User requested to talk to a specialist immediately.");
    } else {
      await this._sendMainMenu(user, conversation);
    }
  }

  async _handleBookingTime(user, conversation, text) {
    const preferredTime = text.trim();
    if (!preferredTime) {
      await this._send(user, conversation, "What day/time generally works best for you?");
      return;
    }

    conversation.context = { ...conversation.context, preferred_time_text: preferredTime };
    conversation.state = "booking_contact";
    await conversation.save();

    await this._send(
      user, conversation,
      "Got it. A couple more details so a specialist can reach you: what's your " +
        "current location (city/country), and an email if you'd like a confirmation? " +
        '(e.g. "Lagos, Nigeria, jane@example.com" — email is optional, reply ' +
        '"skip" to leave it out)'
    );
  }

  async _handleBookingContact(user, conversation, text) {
    const stripped = text.trim();

    const emailMatch = stripped.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    let locationPart;
    if (emailMatch) {
      user.email = emailMatch[0];
      locationPart = (stripped.slice(0, emailMatch.index) + stripped.slice(emailMatch.index + emailMatch[0].length)).trim().replace(/^,+|,+$/g, "").trim();
    } else {
      locationPart = stripped.toLowerCase() === "skip" ? "" : stripped;
    }

    if (locationPart) user.location = locationPart;
    await user.save();

    const preferredTimeText = conversation.context.preferred_time_text;
    await ConsultationBooking.create({
      user_id: user.id,
      conversation_id: conversation.id,
      preferred_time_text: preferredTimeText,
      contact_email: user.email,
      status: "requested",
    });

    let lead = await Lead.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!lead) lead = Lead.build({ user_id: user.id });
    lead.status = "consultation_booked";
    await lead.save();

    const application = await this._getOrCreateApplication(user);
    if (
      APPLICATION_STAGE_ORDER.indexOf(application.stage) < APPLICATION_STAGE_ORDER.indexOf("expert_review")
    ) {
      application.stage = "expert_review";
      await application.save();
    }

    await this._send(
      user, conversation,
      `Thank you! Your consultation request for "${preferredTimeText}" has been ` +
        "logged — a MigraTech specialist will reach out to confirm the exact time."
    );
    await this._escalate(conversation, `Consultation requested for: ${preferredTimeText}`);
  }

  async _offerConsultation(user, conversation) {
    const unlocked = await this._requireTier(user, conversation, "navigate", {
      purpose: "MIGRA PLAN — human expert review",
      pendingAction: "consultation",
    });
    if (!unlocked) return;

    conversation.state = "consultation_menu";
    await conversation.save();
    await this._send(user, conversation, "Would you like to speak with a MigraTech migration specialist?", flows.CONSULTATION_MENU_OPTIONS);
  }

  async _handleConfirmDeletion(user, conversation, text) {
    if (text.trim().toUpperCase() !== CONFIRM_DELETE_PHRASE) {
      conversation.state = "main_menu";
      await conversation.save();
      await this._send(user, conversation, "No changes made.");
      await this._sendMainMenu(user, conversation);
      return;
    }

    const whatsappNumber = user.whatsapp_number;
    await logAction({
      actor: `user:${whatsappNumber}`,
      action: "self_service_delete",
      targetType: "user",
      targetId: user.id,
    });
    await this.whatsappClient.sendText(whatsappNumber, "Your MigraTech data has been deleted. Message us anytime to start fresh.");
    await user.destroy();
  }

  // ------------------------------------------------------------------ //
  // Shared flow logic
  // ------------------------------------------------------------------ //

  async _startFlow(user, conversation, category) {
    const profile = await this._getOrCreateProfile(user);
    profile.migration_objective = category;
    await profile.save();
    conversation.context = { category };
    conversation.state = "collecting";
    await conversation.save();
    await this._getOrCreateApplication(user);
    await this._askNextCollectingQuestion(user, conversation, profile, category);
  }

  async _askNextCollectingQuestion(user, conversation, profile, category) {
    const questions = flows.FLOWS[category] || [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      // == null (not falsy) so a legitimately-answered `false` (e.g. job_offer_status) or
      // `0` (e.g. experience_years) doesn't get treated as "still unanswered" and re-asked
      // forever — only a genuinely unset null/undefined should move on to this question.
      if (profile[q.field_name] == null) {
        conversation.context = { ...conversation.context, category, field_index: i };
        await conversation.save();
        await this._send(user, conversation, q.prompt, q.options);
        return;
      }
    }
    await this._completeFlow(user, conversation, profile, category);
  }

  async _completeFlow(user, conversation, profile, category) {
    const pathway = await this._bestMatchingPathway(profile, category);

    if (!pathway) {
      await this._send(
        user, conversation,
        "Thanks — I don't yet have a specific pathway on file for that " +
          "destination, but a MigraTech specialist can help you explore options there."
      );
      await this._upsertLead(user, profile, null);
      if (category === "business") {
        await this._escalateHighValueBusiness(user, conversation);
        return;
      }
      await this._sendMainMenu(user, conversation);
      return;
    }

    const result = assess(profile, pathway);
    const assessment = await EligibilityAssessment.create({
      user_id: user.id,
      pathway_id: pathway.id,
      result: result.result,
      reasons: result.reasons,
    });

    const lines = [result.message];
    if (result.reasons.length) {
      lines.push("");
      lines.push(...result.reasons.map((r) => `• ${r}`));
    }
    lines.push("");
    lines.push(`Potential option: ${pathway.country.name} — ${pathway.name}`);
    if (pathway.summary) lines.push(pathway.summary);
    if (pathway.is_verified_content && pathway.source_url) {
      const verifiedDate = pathway.last_verified_at ? pathway.last_verified_at.toISOString().slice(0, 10) : "unknown";
      lines.push(`Source: ${pathway.source_url} (verified ${verifiedDate})`);
    }
    const officialResources = pathway.country.official_resources || [];
    if (officialResources.length) {
      lines.push("");
      lines.push("Official government resources:");
      lines.push(...officialResources.map((r) => `• ${r.label}: ${r.url}`));
    }
    lines.push("");
    lines.push(result.disclaimer);
    lines.push("");
    lines.push(FRAUD_EDUCATION_TIP);

    conversation.context = { ...conversation.context, pathway_id: pathway.id };
    conversation.state = "assessment_menu";
    await conversation.save();

    const application = await this._getOrCreateApplication(user);
    application.pathway_id = pathway.id;
    if (APPLICATION_STAGE_ORDER.indexOf(application.stage) < APPLICATION_STAGE_ORDER.indexOf("pathway_selection")) {
      application.stage = "pathway_selection";
    }
    await application.save();

    await this._send(user, conversation, lines.join("\n"), ASSESSMENT_MENU_OPTIONS);
    await this._upsertLead(user, profile, assessment);

    if (category === "business") {
      await this._escalateHighValueBusiness(user, conversation);
    }
  }

  /** FR-11 "high-value client" trigger: business/investment migration is MigraTech's own
   * highest-touch segment (PRD section 6E). Runs after the automated assessment so the user
   * gets immediate value and the specialist inherits a filled-out profile, rather than going
   * straight to silence the moment "business" is mentioned. */
  async _escalateHighValueBusiness(user, conversation) {
    await this._send(user, conversation, ESCALATION_MESSAGE);
    await this._escalate(conversation, "Business/investment migration pathway — high-value case routed to a specialist.");
  }

  async _handleDocumentsRequest(user, conversation) {
    const profile = await this._getOrCreateProfile(user);
    const pathway = profile.migration_objective
      ? await this._bestMatchingPathway(profile, profile.migration_objective)
      : null;
    if (pathway) {
      const documents = await Document.findAll({ where: { user_id: user.id } });
      const checklist = generateChecklist(pathway, documents);
      await this._send(user, conversation, renderChecklistWhatsappText(checklist));
      await this._sendMainMenu(user, conversation);
    } else {
      await this._send(user, conversation, "Let's first find your pathway so I can generate an accurate checklist.");
      conversation.state = "goal_selection";
      await conversation.save();
      await this._send(user, conversation, "What is your primary goal?", flows.GOAL_OPTIONS);
    }
  }

  async _getOrCreateApplication(user) {
    let application = await Application.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!application) {
      application = await Application.create({ user_id: user.id, stage: "profile_assessment", status: "in_progress" });
    }
    return application;
  }

  /** Returns true if tracking was shown (or there was nothing to track yet) — false if the
   * user got redirected into the payment flow instead, so callers know whether it's still
   * safe to follow up with the main menu (see the two call sites) without clobbering that. */
  async _handleTrackApplication(user, conversation) {
    const application = await Application.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!application) {
      await this._send(
        user, conversation,
        "You don't have a migration journey started yet — choose \"Explore Migration " +
          'Options" from the main menu to begin.'
      );
      return true;
    }

    const unlocked = await this._requireTier(user, conversation, "relocate", {
      purpose: "MIGRA GO — application tracking",
      pendingAction: "track_application",
    });
    if (!unlocked) return false;

    const documents = await Document.findAll({ where: { user_id: user.id } });
    const pathway = application.pathway_id ? await Pathway.findByPk(application.pathway_id) : null;
    const requiredDocs = pathway ? (pathway.documents || []).length : 0;
    const uploadedDocs = documents.filter((d) => ["uploaded", "verified"].includes(d.status)).length;
    const docPct = requiredDocs ? Math.round((100 * uploadedDocs) / requiredDocs) : 0;

    const currentIndex = APPLICATION_STAGE_ORDER.indexOf(application.stage);
    const lines = ["Migration Journey", ""];
    APPLICATION_STAGE_ORDER.forEach((stage, i) => {
      const label = APPLICATION_STAGE_LABELS[stage];
      const stageIndex = i;
      if (stage === "documents" && requiredDocs) {
        lines.push(`${i + 1}. ${label} — 🟡 ${docPct}% Complete`);
      } else if (stageIndex < currentIndex || (stageIndex === currentIndex && application.status === "complete")) {
        lines.push(`${i + 1}. ${label} — ✅ Complete`);
      } else {
        lines.push(`${i + 1}. ${label} — ⏳ Pending`);
      }
    });

    await this._send(user, conversation, lines.join("\n"));
    return true;
  }

  async _tryShortcutFromFreeText(user, conversation, text) {
    const extracted = await understand(this.llmClient, text);
    if (await this._maybeEscalate(user, conversation, text, extracted)) return true;

    if (extracted.intent === "application_status") {
      if (await this._handleTrackApplication(user, conversation)) {
        await this._sendMainMenu(user, conversation);
      }
      return true;
    }

    const profile = await this._getOrCreateProfile(user);
    const updatedFields = [];
    for (const fieldName of [
      "destination_country", "occupation", "education", "experience_years",
      "age", "language_ability", "family_status", "timeline",
    ]) {
      const value = extracted[fieldName];
      if (value && !profile[fieldName]) {
        profile[fieldName] = value;
        updatedFields.push(fieldName);
      }
    }
    if (updatedFields.length) await profile.save();

    if (extracted.migration_objective) {
      const destClause = profile.destination_country ? ` to ${profile.destination_country}` : "";
      await this._send(
        user, conversation,
        `Great, I can help you explore legitimate migration pathways${destClause}. ` +
          "Let's get a bit more detail."
      );
      await this._startFlow(user, conversation, extracted.migration_objective);
      return true;
    }

    if (updatedFields.length && profile.destination_country) {
      await this._send(
        user, conversation,
        "Great, I can help you explore legitimate migration pathways to " +
          `${profile.destination_country}. What is your primary goal?`,
        flows.GOAL_OPTIONS
      );
      conversation.state = "goal_selection";
      await conversation.save();
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------------ //
  // Cross-cutting helpers
  // ------------------------------------------------------------------ //

  async _bestMatchingPathway(profile, category) {
    if (profile.destination_country) {
      const matches = await getPathwaysForCountry(profile.destination_country, category);
      if (matches.length) return matches[0];
    }
    const matches = await searchPathways(`${category || ""} ${profile.destination_country || ""}`.trim());
    return matches.length ? matches[0] : null;
  }

  async _answerFaq(user, conversation, questionText) {
    const faqs = await searchFaqs(questionText);
    const snippets = faqs.map((f) => {
      let snippet = `Q: ${f.question}\nA: ${f.answer}`;
      if (f.is_verified_content && f.source_url) snippet += `\nSource: ${f.source_url}`;
      return snippet;
    });
    const result = await this.llmClient.answerGrounded(questionText, snippets);

    if (!passesConfidenceThreshold(result.confidence)) {
      await this._send(user, conversation, CONFIDENCE_FALLBACK_MESSAGE);
      await this._escalate(conversation, "Low AI confidence answering a user question.");
      return false;
    }

    const banned = findBannedClaim(result.answer);
    if (banned) {
      logger.warn({ banned }, "Blocked banned claim in AI answer");
      await this._send(user, conversation, CONFIDENCE_FALLBACK_MESSAGE);
      await this._escalate(conversation, `AI answer contained a banned claim (${JSON.stringify(banned)}).`);
      return false;
    }

    await this._send(user, conversation, result.answer);
    return true;
  }

  // ------------------------------------------------------------------ //
  // DISCOVER / NAVIGATE / RELOCATE payment gate
  // ------------------------------------------------------------------ //

  /** Returns true if `user` already has `tier` unlocked. Otherwise puts the conversation
   * into the payment-loop state (awaiting_payment / awaiting_payment_email) and sends the
   * appropriate prompt, then returns false — callers must stop and not perform the gated
   * action. NAVIGATE is a fixed self-serve Paystack checkout; RELOCATE's price varies by
   * pathway/service (product spec), so it's always a staff-quoted custom link instead. */
  async _requireTier(user, conversation, tier, { purpose, pendingAction }) {
    if (await hasPaidTier(user.id, tier)) return true;

    if (tier !== "navigate") {
      conversation.context = { ...conversation.context, pending_tier: tier, pending_action: pendingAction, pending_purpose: purpose };
      conversation.state = "awaiting_payment";
      await conversation.save();
      await this._send(
        user, conversation,
        `"${purpose}" is part of MigraTech's Relocate package, which is priced to your ` +
          "specific migration pathway. A MigraTech specialist will follow up with a custom " +
          'quote and payment link. Reply "menu" anytime to go back for now.'
      );
      await this._escalate(conversation, `Relocate package requested (${purpose}) — needs a custom quote.`);
      return false;
    }

    if (!user.email) {
      conversation.context = { ...conversation.context, pending_tier: tier, pending_action: pendingAction, pending_purpose: purpose };
      conversation.state = "awaiting_payment_email";
      await conversation.save();
      await this._send(
        user, conversation,
        `To unlock "${purpose}", I first need an email address for your payment receipt. ` +
          'What\'s a good email to use? (or reply "cancel")'
      );
      return false;
    }

    await this._sendNavigatePaymentLink(user, conversation, purpose, pendingAction);
    return false;
  }

  async _sendNavigatePaymentLink(user, conversation, purpose, pendingAction) {
    if (!settings.paystackConfigured) {
      await this._send(
        user, conversation,
        "Online payment isn't set up yet — a MigraTech specialist will reach out to " +
          `arrange payment for "${purpose}".`
      );
      await this._escalate(conversation, `Wanted to pay for "${purpose}" but Paystack isn't configured yet.`);
      return;
    }

    const reference = `navigate-${randomUUID()}`;
    const payment = await Payment.create({
      user_id: user.id,
      amount: settings.navigatePriceNgn,
      currency: "NGN",
      purpose,
      status: "pending",
      tier: "navigate",
      provider: "paystack",
      reference,
    });

    try {
      const { authorization_url } = await initializeTransaction({
        email: user.email,
        amountNaira: settings.navigatePriceNgn,
        reference,
        metadata: { user_id: user.id, tier: "navigate" },
      });
      conversation.context = {
        ...conversation.context,
        pending_tier: "navigate",
        pending_action: pendingAction,
        pending_purpose: purpose,
        pending_payment_id: payment.id,
        pending_checkout_url: authorization_url,
      };
      conversation.state = "awaiting_payment";
      await conversation.save();
      await this._send(
        user, conversation,
        `To unlock "${purpose}" (₦${settings.navigatePriceNgn.toLocaleString()}), complete ` +
          `payment here:\n${authorization_url}\n\nI'll confirm automatically as soon as it ` +
          'goes through — message me anytime to check, or reply "menu" to go back for now.'
      );
    } catch (err) {
      logger.error({ err }, "Failed to create Paystack payment link");
      await this._send(
        user, conversation,
        "I couldn't generate a payment link just now — a MigraTech specialist will follow up to arrange payment."
      );
      await this._escalate(conversation, "Failed to generate Paystack payment link.");
    }
  }

  async _handleAwaitingPaymentEmail(user, conversation, text) {
    const stripped = text.trim();
    if (["cancel", "menu", "back"].includes(stripped.toLowerCase())) {
      conversation.context = { ...conversation.context, pending_tier: null, pending_action: null, pending_purpose: null };
      await this._sendMainMenu(user, conversation);
      return;
    }

    const emailMatch = stripped.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (!emailMatch) {
      await this._send(user, conversation, 'That doesn\'t look like a valid email — what\'s a good email to use? (or reply "cancel")');
      return;
    }
    user.email = emailMatch[0];
    await user.save();

    const { pending_purpose: purpose, pending_action: pendingAction } = conversation.context;
    await this._sendNavigatePaymentLink(user, conversation, purpose, pendingAction);
  }

  async _handleAwaitingPayment(user, conversation, text) {
    const stripped = text.trim().toLowerCase();
    if (["cancel", "menu", "back"].includes(stripped)) {
      conversation.context = {
        ...conversation.context,
        pending_tier: null, pending_action: null, pending_purpose: null, pending_checkout_url: null, pending_payment_id: null,
      };
      await this._sendMainMenu(user, conversation);
      return;
    }

    const { pending_tier: tier, pending_checkout_url: checkoutUrl, pending_purpose: purpose } = conversation.context;
    if (tier === "navigate" && checkoutUrl) {
      await this._send(
        user, conversation,
        `Still waiting on payment for "${purpose || "your MIGRA PLAN package"}" — complete ` +
          `it here:\n${checkoutUrl}\n\nI'll confirm automatically once it clears, or reply ` +
          '"menu" to go back for now.'
      );
    } else {
      await this._send(
        user, conversation,
        "A MigraTech specialist is still preparing your custom Relocate quote — they'll " +
          'follow up soon. Reply "menu" to go back for now.'
      );
    }
  }

  /** Called by the Paystack webhook (see payments/webhookRoutes.js) once a payment is
   * verified paid. Picks the user's most recent conversation back up and re-runs whatever
   * gated action they were originally trying to reach — now that the payment exists,
   * _requireTier's hasPaidTier check passes and it proceeds normally instead of re-gating. */
  async handlePaymentConfirmed(payment) {
    const user = await User.findByPk(payment.user_id);
    if (!user) return;

    const conversation = await Conversation.findOne({ where: { user_id: user.id }, order: [["updated_at", "DESC"]] });
    if (!conversation) return;

    const pendingAction = conversation.context?.pending_action;

    await this._send(user, conversation, `✅ Payment received for "${payment.purpose}" — you're all set.`);

    conversation.context = {
      ...conversation.context,
      pending_tier: null, pending_action: null, pending_purpose: null, pending_checkout_url: null, pending_payment_id: null,
    };
    conversation.state = "main_menu";
    await conversation.save();

    if (pendingAction === "consultation") {
      await this._offerConsultation(user, conversation);
    } else if (pendingAction === "track_application") {
      if (await this._handleTrackApplication(user, conversation)) {
        await this._sendMainMenu(user, conversation);
      }
    } else {
      await this._sendMainMenu(user, conversation);
    }
  }

  async _maybeEscalate(user, conversation, text, extracted) {
    const reason = detectEscalationReason(text, extracted, conversation.fallback_count);
    if (!reason) return false;
    await this._send(user, conversation, ESCALATION_MESSAGE);
    if (reason.toLowerCase().includes("suspicious") || reason.toLowerCase().includes("fraud")) {
      await this._send(user, conversation, FRAUD_WARNING_MESSAGE);
    }
    await this._escalate(conversation, reason);
    return true;
  }

  async _escalate(conversation, reason) {
    // Deliberately does NOT touch conversation.state: the bot keeps talking (see the
    // handleInbound guard above), so the conversation must stay wherever it already was
    // (main_menu, collecting, etc.) rather than being parked in a dead state. escalation_status
    // is only a flag for staff visibility/notification here — a human must explicitly act
    // (resolveConversation/sendStaffMessage) to actually silence the bot.
    conversation.escalation_status = "requested";
    conversation.escalation_reason = reason;
    await conversation.save();
    await this._notifyStaff(conversation, reason);
  }

  async _notifyStaff(conversation, reason) {
    const url = settings.staffNotificationWebhookUrl;
    if (!url) {
      logger.info({ conversationId: conversation.id, reason }, "Escalation (no staff webhook configured)");
      return;
    }
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversation.id, reason }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      logger.error({ err }, "Failed to notify staff webhook");
    }
  }

  async _upsertLead(user, profile, latestAssessment) {
    const documents = await Document.findAll({ where: { user_id: user.id } });
    const conversations = await Conversation.findAll({ where: { user_id: user.id }, attributes: ["id"] });
    const conversationIds = conversations.map((c) => c.id);
    const messageCount = conversationIds.length
      ? await Message.count({ where: { conversation_id: conversationIds } })
      : 0;

    const result = scoreLead({
      profile,
      latestEligibility: latestAssessment,
      documents,
      requiredDocumentCount: 0,
      messageCount,
    });

    let lead = await Lead.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!lead) lead = Lead.build({ user_id: user.id });
    lead.score = result.score;
    lead.classification = result.classification;
    lead.reasons = result.reasons;
    await lead.save();
  }

  async _getOrCreateProfile(user) {
    let profile = await MigrationProfile.findOne({ where: { user_id: user.id } });
    if (!profile) profile = await MigrationProfile.create({ user_id: user.id });
    return profile;
  }

  async _sendMainMenu(user, conversation, prefix = null) {
    conversation.state = "main_menu";
    await conversation.save();
    const text = (prefix ? prefix + "\n\n" : "") + "What would you like to do?";
    await this._send(user, conversation, text, flows.MAIN_MENU_OPTIONS, "Main Menu");
  }

  async _send(user, conversation, text, options = null, listButtonText = null) {
    let result;
    if (options && options.length > 3) {
      result = await this.whatsappClient.sendListOptions(user.whatsapp_number, text, listButtonText || "Choose", options);
    } else if (options && options.length) {
      result = await this.whatsappClient.sendButtonOptions(user.whatsapp_number, text, options);
    } else {
      result = await this.whatsappClient.sendText(user.whatsapp_number, text);
    }

    let loggedText = text;
    if (options && options.length) {
      loggedText += "\n\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    }
    await Message.create({
      conversation_id: conversation.id,
      direction: "outbound",
      sender: "bot",
      text: loggedText,
      whatsapp_message_id: result?.key?.id ?? null,
    });
  }
}
