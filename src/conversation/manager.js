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
import { CONFIDENCE_FALLBACK_MESSAGE, LOW_CONFIDENCE_MESSAGE, findBannedClaim, passesConfidenceThreshold } from "../ai/guardrails.js";
import { LLMClient } from "../ai/llmClient.js";
import { understand } from "../ai/nlu.js";
import * as flows from "./flows.js";
import { ESCALATION_MESSAGE, FRAUD_WARNING_MESSAGE, detectEscalationReason } from "./escalation.js";
import {
  Application,
  CaseMessage,
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
  Vendor,
} from "../db/models.js";
import { listCaseMessages, markCaseMessagesRead, postCaseMessage } from "../cases/messaging.js";
import { generateChecklist, renderChecklistWhatsappText } from "../documents/checklist.js";
import { LocalEncryptedStorage } from "../documents/storage.js";
import { assess } from "../eligibility/engine.js";
import { getPathwaysForCountry, listCountries, searchFaqs, searchPathways } from "../knowledgeBase/service.js";
import { scoreLead } from "../leads/scoring.js";
import { initializeTransaction } from "../payments/paystackClient.js";
import { hasPaidTier } from "../payments/tierAccess.js";
import { findRelocateUrgentItem } from "../relocate/nudge.js";

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

// Relocate-only extension of the pipeline, for pillars 4/5 (pre-departure prep, arrival &
// settlement). Deliberately NOT appended to APPLICATION_STAGE_ORDER itself — portal/
// service.js's stageProgressPercent computes (idx+1)/APPLICATION_STAGE_ORDER.length for
// *every* application regardless of tier, so lengthening that array would silently drop
// every existing Discover/Navigate-only user's progress %. Used only by _handleTrackApplication,
// which is already 100% relocate-gated via its own _requireTier call, so switching only that
// render is safe. Reaching these two stages is staff-only (admin's updateApplicationStage) —
// nothing in this codebase can detect "actually received a visa" or "actually travelled".
export const RELOCATE_STAGE_ORDER = [...APPLICATION_STAGE_ORDER, "pre_departure", "settlement"];
export const RELOCATE_STAGE_LABELS = {
  ...APPLICATION_STAGE_LABELS,
  pre_departure: "Pre-Departure Preparation",
  settlement: "Arrival & Settlement",
};

const FRAUD_EDUCATION_TIP =
  "🛡️ Reminder: legitimate migration never requires paying government fees into a " +
  "personal bank account, and no one can guarantee visa approval — watch out for " +
  "anyone who claims otherwise.";

// Sent as separate messages (not one paragraph) so the very first contact feels like a
// human assistant introducing themselves — a brand line, then what we do, then the
// disclaimer/consent — rather than one wall of text.
const WELCOME_MESSAGES = [
  "👋 Welcome to MigraTech — Migration, Simplified.",
  "I'm your migration assistant — I can help you explore legitimate options to work, " +
    "study, join family abroad, start a business, or figure out where to go if you're " +
    "not sure yet.",
  "This is general guidance, not a visa guarantee — official decisions are always made " +
    "by the relevant government/immigration authority. By continuing, you agree to " +
    "MigraTech processing your information to help you (reply STOP anytime to opt out).",
];

const STOP_KEYWORDS = new Set(["stop", "unsubscribe", "opt out", "optout"]);
const DELETE_DATA_KEYWORDS = new Set(["delete my data", "delete data", "delete my account"]);
const CONFIRM_DELETE_PHRASE = "CONFIRM DELETE";
const ASSESSMENT_MENU_OPTIONS = ["Check required documents", "Speak to a specialist", "Back to main menu"];

// Mirrors the website's /resources page (src/views/portal/resources.ejs) — kept in sync
// manually since one lives as WhatsApp text and the other as HTML; if that page's content
// changes, update this too.
const SITE_BASE_URL = "https://migra.ng";
const RESOURCES_MESSAGE =
  "*Resources*\n\n" +
  "Know more. Move smarter. Migration decisions deserve better information — here's " +
  "where to find it.\n\n" +
  "*Migration Guides* — practical guides on work, study, and family migration, " +
  "relocation, visa pathways, documentation, job searches, and settlement.\n" +
  `${SITE_BASE_URL}/guides\n\n` +
  "*Country Guides* — migration opportunities and considerations across different destinations.\n" +
  `${SITE_BASE_URL}/countries\n\n` +
  "*Migration Calculator* — estimate migration-related costs and financial preparation. " +
  "(Coming soon — we're still building this out.)\n\n" +
  "*Migra Blog* — insights, updates, opportunities and expert perspectives on migration and global opportunities.\n" +
  `${SITE_BASE_URL}/blog\n\n` +
  "*Frequently Asked Questions* — answers to the questions Africans ask most about moving abroad.\n" +
  `${SITE_BASE_URL}/#faqs\n\n` +
  "⚠️ Important: migration policies and requirements change. Always verify critical " +
  "requirements against the relevant official government authority or a qualified professional.";

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

    // Silently flags genuine safety/liability triggers for staff (fraud, legal, visa refusal,
    // immigration violation, sensitive family circumstances, document concerns) — see
    // escalation.js — but never halts the conversation; _maybeEscalate always returns false
    // here. The only ways a conversation actually goes quiet are the payment gate
    // (_requireTier) and a staff member manually taking over in the admin dashboard.
    await this._maybeEscalate(user, conversation, text, null);

    const handlers = {
      welcome: this._handleWelcome,
      collecting_name: this._handleCollectingName,
      main_menu: this._handleMainMenu,
      discover_intake: this._handleDiscoverIntake,
      navigate_profile_update: this._handleNavigateProfileUpdate,
      navigate_assessment: this._handleNavigateAssessment,
      navigate_pathway_selection: this._handleNavigatePathwaySelection,
      navigate_menu: this._handleNavigateMenu,
      relocate_phase_question: this._handleRelocatePhaseQuestion,
      relocate_pathway_confirm: this._handleRelocatePathwayConfirm,
      relocate_menu: this._handleRelocateMenu,
      relocate_expert_chat: this._handleRelocateExpertChat,
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
    // Matches either an untouched "missing" row or one already marked "declared" (they told
    // us they had it, this upload is almost certainly that one) -- fetching all candidates
    // for this type and picking in JS avoids needing a second Sequelize Op import here.
    const candidates = await Document.findAll({ where: { user_id: user.id, document_type: documentType } });
    let document = candidates.find((d) => d.status === "declared") || candidates.find((d) => d.status === "missing");
    if (!document) document = Document.build({ user_id: user.id, document_type: documentType });
    document.file_location = filePath;
    document.original_filename = filename;
    document.mime_type = mimeType;
    document.whatsapp_media_id = whatsappMediaId;
    document.status = "uploaded";
    document.verification_status = "unreviewed";
    document.uploaded_at = new Date();

    // Real extraction only — reads the actual uploaded image via vision, never invents
    // content. Wrapped so a vision failure/rate-limit/non-image file never blocks the upload
    // itself; extracted_fields just stays null in that case, same as before this existed.
    let extractionNote = "";
    try {
      const extracted = await this.llmClient.extractDocumentFields(mimeType, content);
      if (extracted) {
        document.extracted_fields = extracted;
        if (extracted.legible && extracted.document_type_guess) {
          extractionNote = ` Looks like: ${extracted.document_type_guess}.`;
        }
      }
    } catch (err) {
      logger.error({ err }, "Document extraction failed (upload itself still succeeded)");
    }

    await document.save();

    await this._send(
      user, conversation,
      `Got it — I've received your file and logged it as "${documentType}".${extractionNote} ` +
        "A MigraTech specialist will review it."
    );
    const profile = await this._getOrCreateProfile(user);
    await this._upsertLead(user, profile, null);
  }

  async _nextMissingDocumentType(user, conversation) {
    // application.pathway_id is the authoritative source once explicit pathway selection
    // exists (Navigate's _buildPathwayShortlist/_handleNavigatePathwaySelection only ever set
    // that, never conversation.context.pathway_id) — conversation.context.pathway_id is kept
    // as a fallback for the older Discover-flow path, which still sets it.
    const application = await Application.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    const pathwayId = application?.pathway_id || conversation.context.pathway_id;
    const pathway = pathwayId ? await Pathway.findByPk(pathwayId, { include: [{ model: Country, as: "country" }] }) : null;
    if (!pathway) return "Uploaded document";
    const documents = await Document.findAll({ where: { user_id: user.id } });
    const checklist = generateChecklist(pathway, documents);
    // Prefer a "declared" item (they just told us they have it) over an untouched "missing"
    // one — a file arriving right after "I have my passport" is almost certainly that
    // document, not some unrelated still-missing item.
    const target = checklist.items.find((item) => item.status === "declared") || checklist.items.find((item) => item.status === "missing");
    return target ? target.name : "Additional document";
  }

  // ------------------------------------------------------------------ //
  // State handlers
  // ------------------------------------------------------------------ //

  async _handleWelcome(user, conversation, text) {
    if (user.name) {
      // A returning user we've already been introduced to — no need for the full intro
      // (or asking their name) again.
      if (isGreeting(text) || !(await this._tryShortcutFromFreeText(user, conversation, text))) {
        await this._sendMainMenu(user, conversation, `Good to see you again, ${user.name}!`);
      }
      return;
    }

    // First contact — introduce ourselves properly, one short message at a time (like a
    // human assistant would, not one wall of text) before anything else, rather than
    // silently pulling a name from WhatsApp account metadata. Whatever they said (a real
    // migration statement, not just "hi") is remembered and resumed right after they answer,
    // so asking for a name doesn't waste it.
    for (const msg of WELCOME_MESSAGES) {
      await this._send(user, conversation, msg);
    }

    conversation.context = { pending_first_message: isGreeting(text) ? null : text };
    conversation.state = "collecting_name";
    await conversation.save();
    await this._send(user, conversation, "Before we get started — what should I call you?");
  }

  async _handleCollectingName(user, conversation, text) {
    const name = text.trim().slice(0, 80);
    if (!name) {
      await this._send(user, conversation, "What should I call you?");
      return;
    }

    user.name = name;
    await user.save();

    const pendingFirstMessage = conversation.context?.pending_first_message;
    conversation.context = {};
    await conversation.save();

    await this._send(user, conversation, `Great to meet you, ${name}! 👋`);

    if (pendingFirstMessage && (await this._tryShortcutFromFreeText(user, conversation, pendingFirstMessage))) return;
    await this._sendMainMenu(user, conversation);
  }

  async _handleMainMenu(user, conversation, text, interactiveId) {
    // A bare "hi"/"hello" mid-conversation isn't a failed answer — it's the user checking
    // back in. Re-show the menu plainly rather than scolding them with "didn't catch that"
    // and burning a fallback_count strike (which would otherwise push them toward escalation).
    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await this._sendMainMenu(user, conversation);
      return;
    }

    const idx = resolveSelection(text, interactiveId, flows.MAIN_MENU_OPTIONS);
    if (idx === null) {
      if (await this._tryShortcutFromFreeText(user, conversation, text)) return;
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        "The user is at MigraTech's main menu and just replied with something that isn't one of the menu options."
      );
      await this._sendMainMenu(user, conversation, acknowledged ? null : "Sorry, I didn't quite catch that.");
      return;
    }

    conversation.fallback_count = 0;
    const option = flows.MAIN_MENU_OPTIONS[idx];

    if (["Explore Migration Options", "Check My Eligibility"].includes(option)) {
      await this._startDiscoverFlow(user, conversation);
    } else if (option === "Work Abroad") {
      await this._startDiscoverFlow(user, conversation, "Work");
    } else if (option === "Study Abroad") {
      await this._startDiscoverFlow(user, conversation, "Study");
    } else if (option === "Family Migration") {
      await this._startDiscoverFlow(user, conversation, "Family reunification");
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
    } else if (option === "Resources") {
      await this._send(user, conversation, RESOURCES_MESSAGE);
      await this._sendMainMenu(user, conversation, "Anything else I can help with?");
    } else {
      await conversation.save();
    }
  }

  /** Walks flows.DISCOVER_SECTIONS one field at a time — the generalized replacement for the
   * old per-category goal_selection/destination_discovery/collecting trio. A question's
   * `target` ("profile" or "user") decides which record gets read/written; `skipIf(profile)`
   * lets conditional sub-questions (travel detail, visa refusal detail, dependants detail,
   * family-abroad detail, the asylum follow-up) skip themselves without being asked at all;
   * `allowSkip` lets the doc's own explicit "(Optional)" fields accept a literal "skip" reply. */
  async _handleDiscoverIntake(user, conversation, text, interactiveId) {
    const profile = await this._getOrCreateProfile(user);
    const fieldName = conversation.context.current_field;
    const q = flows.DISCOVER_SECTIONS.find((f) => f.field_name === fieldName);
    if (!q) {
      // Stale/corrupted context (e.g. a conversation mid-flow from before this redesign) —
      // just resume from wherever the profile actually is rather than erroring out.
      await this._askNextDiscoverQuestion(user, conversation, profile);
      return;
    }

    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await conversation.save();
      await this._send(user, conversation, q.prompt, q.options);
      return;
    }

    if (q.allowSkip && /^skip$/i.test(text.trim())) {
      const target = q.target === "user" ? user : profile;
      target[q.field_name] = "";
      await target.save();
      conversation.fallback_count = 0;
      await conversation.save();
      await this._askNextDiscoverQuestion(user, conversation, profile);
      return;
    }

    let value = null;
    if (q.options.length) {
      const optIdx = resolveSelection(text, interactiveId, q.options);
      if (optIdx !== null) value = q.parser(q.options[optIdx]);
    }
    if (value === null) value = q.parser(text);

    if (value === null && !q.options.length) {
      // Free-text question with no direct parse — try the same AI NLU extraction fallback
      // the old flow used. Most of the new fields have no NLU mapping, so this mainly helps
      // the handful (destination/occupation/education/etc.) the extractor already knows.
      const extracted = await understand(this.llmClient, text);
      await this._maybeEscalate(user, conversation, text, extracted);
      value = extracted[q.field_name] ?? null;
    }

    if (value === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        `The user is going through MigraTech's Discover intake and is being asked: "${q.prompt}" ` +
          "— their reply didn't give a usable answer to that specific question."
      );
      await this._send(user, conversation, (acknowledged ? "" : "Sorry, I didn't quite catch that. ") + q.prompt, q.options);
      return;
    }

    // A handful of short "named entity" fields (name, nationality, language, occupation, etc.)
    // parse "successfully" even when the reply is actually gibberish or just an echo of the
    // question itself (e.g. "languge" in reply to "what's your preferred language") — a plain
    // non-empty-string parser can't tell the difference. q.validate opts specific fields into
    // this extra AI check; genuinely open-ended fields (migration_goal_detail, biggest_question,
    // etc.) deliberately skip it since almost any text is a legitimate answer there, and it'd
    // just add latency/cost for no benefit.
    if (q.validate) {
      const { valid } = await this.llmClient.validateAnswer(q.prompt, text);
      if (!valid) {
        conversation.fallback_count += 1;
        await conversation.save();
        await this._send(user, conversation, "Hmm, that doesn't quite look like an answer to this — " + q.prompt, q.options);
        return;
      }
    }

    const target = q.target === "user" ? user : profile;
    target[q.field_name] = value;
    await target.save();
    conversation.fallback_count = 0;
    await conversation.save();

    if (q.field_name === "migration_reason") {
      profile.migration_objective = flows.migrationObjectiveFor(value);
      await profile.save();
      if (value === flows.ASYLUM_REASON) {
        // Silent staff flag only — bot keeps going, same pattern as the fraud/legal/violation
        // triggers in escalation.js. A specialist gets visibility into a safety-sensitive case
        // without interrupting someone who may already be in a vulnerable situation.
        await this._escalate(conversation, "User indicated asylum/protection-related migration reason — flagged for sensitive review.");
      }
    } else if (q.field_name === "date_of_birth") {
      const ageYears = Math.floor((Date.now() - new Date(value).getTime()) / (365.25 * 24 * 3600 * 1000));
      if (ageYears >= 0 && ageYears < 120) {
        profile.age = ageYears;
        await profile.save();
      }
    }

    await this._askNextDiscoverQuestion(user, conversation, profile);
  }

  async _handleAssessmentMenu(user, conversation, text, interactiveId) {
    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await conversation.save();
      await this._send(user, conversation, "Would you like to:", ASSESSMENT_MENU_OPTIONS);
      return;
    }

    const idx = resolveSelection(text, interactiveId, ASSESSMENT_MENU_OPTIONS);
    if (idx === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        "The user just received a preliminary migration eligibility assessment and is being " +
          "asked what to do next (check documents, speak to a specialist, or go back to the " +
          "main menu) — they replied with something that isn't one of those options."
      );
      await this._send(
        user, conversation,
        acknowledged ? "Would you like to:" : "Could you pick one of the options below?",
        ASSESSMENT_MENU_OPTIONS
      );
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
    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await conversation.save();
      await this._send(user, conversation, "What would you like to know?");
      return;
    }

    if (await this._answerFaq(user, conversation, text)) {
      await this._sendMainMenu(user, conversation, "Anything else I can help with?");
    }
  }

  async _handleConsultationMenu(user, conversation, text, interactiveId) {
    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await conversation.save();
      await this._send(user, conversation, "Would you like to speak with a MigraTech migration specialist?", flows.CONSULTATION_MENU_OPTIONS);
      return;
    }

    const idx = resolveSelection(text, interactiveId, flows.CONSULTATION_MENU_OPTIONS);
    if (idx === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        "The user is being asked whether they'd like to book a consultation, talk to an " +
          "expert now, or continue later — they replied with something that isn't one of " +
          "those options."
      );
      await this._send(
        user, conversation,
        acknowledged ? "Would you like to speak with a MigraTech migration specialist?" : "Could you pick one of the options below?",
        flows.CONSULTATION_MENU_OPTIONS
      );
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
      purpose: "MIGRA Navigate — human expert review",
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

  /** `presetReason` is one of flows.MIGRATION_REASON_OPTIONS' exact labels — used by the main
   * menu's "Work Abroad"/"Study Abroad"/"Family Migration" shortcuts so the migration_reason
   * question is pre-answered (and therefore skipped) for someone who already told us their
   * goal by tapping that option, without duplicating the rest of the 8-section intake. */
  async _startDiscoverFlow(user, conversation, presetReason = null) {
    const profile = await this._getOrCreateProfile(user);
    if (presetReason && profile.migration_reason == null) {
      profile.migration_reason = presetReason;
      profile.migration_objective = flows.migrationObjectiveFor(presetReason);
      await profile.save();
    }
    conversation.context = { ...conversation.context, flow: "discover" };
    conversation.state = "discover_intake";
    await conversation.save();
    await this._getOrCreateApplication(user);
    await this._askNextDiscoverQuestion(user, conversation, profile);
  }

  async _askNextDiscoverQuestion(user, conversation, profile) {
    for (const q of flows.DISCOVER_SECTIONS) {
      if (q.skipIf && q.skipIf(profile)) continue;
      const target = q.target === "user" ? user : profile;
      // == null (not falsy) so a legitimately-answered `false`/`0` isn't treated as
      // "still unanswered" and re-asked forever — same reasoning the old flow used.
      if (target[q.field_name] == null) {
        conversation.context = { ...conversation.context, flow: "discover", current_field: q.field_name };
        await conversation.save();
        await this._send(user, conversation, q.prompt, q.options);
        return;
      }
    }
    await this._completeDiscoverFlow(user, conversation, profile);
  }

  async _completeDiscoverFlow(user, conversation, profile) {
    // The intake asks destination_countries (free text, plural) and the structured family
    // section separately from the two single-value fields the existing pathway-matching/
    // eligibility logic (_bestMatchingPathway, eligibility/engine.js) already keys off —
    // derive those here so that logic keeps working completely unmodified.
    if (!profile.destination_country && profile.destination_countries) {
      profile.destination_country = profile.destination_countries.split(/,| and |\/|;/i)[0].trim();
    }
    if (!profile.family_status) {
      const parts = [];
      if (profile.migrating_with) parts.push(`Migrating: ${profile.migrating_with}`);
      if (profile.marital_status) parts.push(profile.marital_status);
      if (profile.has_dependents) parts.push(`${profile.dependents_count || "some"} dependent(s)`);
      if (parts.length) profile.family_status = parts.join("; ");
    }
    await profile.save();

    const pathway = await this._bestMatchingPathway(profile, profile.migration_objective);
    // Drives whether we pitch Navigate below — re-pitching something someone already bought
    // doesn't make sense, but everyone else should always see the direct next step rather
    // than dead-ending into a generic menu. Not gated on profile.wants_navigate (the intake's
    // closing question) -- that's still recorded for lead scoring, but a "maybe later" answer
    // shouldn't mean the free tier ends without ever showing the real paid option.
    const alreadyHasNavigate = await hasPaidTier(user.id, "navigate");

    if (!pathway) {
      const destClause = profile.destination_country ? ` for ${profile.destination_country}` : "";
      await this._send(
        user, conversation,
        "Your MIGRA Discovery Profile is Ready 🎉\n\n" +
          `Thanks for sharing all of that — I don't yet have a specific pathway on file${destClause}, ` +
          "but based on what you've told us, a MigraTech specialist can map out real options " +
          "there. This is only an initial match: real eligibility depends on factors like your " +
          "qualifications, finances, family situation, immigration history and " +
          "destination-specific requirements."
      );
      await this._upsertLead(user, profile, null);
      if (alreadyHasNavigate) {
        await this._sendMainMenu(user, conversation, "Anything else I can help with?");
      } else {
        await this._requireTier(user, conversation, "navigate", {
          purpose: "MIGRA Navigate — deeper migration pathway analysis", pendingAction: null,
        });
      }
      return;
    }

    const result = assess(profile, pathway);
    const assessment = await EligibilityAssessment.create({
      user_id: user.id,
      pathway_id: pathway.id,
      result: result.result,
      reasons: result.reasons,
      pathway_version: pathway.version,
    });

    const lines = ["Your MIGRA Discovery Profile is Ready 🎉", "", result.message];
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
    lines.push("But this is only an initial match — your eligibility can depend on factors such as " +
      "your qualifications, occupation, work experience, finances, family situation, " +
      "immigration history and destination-specific requirements.");
    lines.push("");
    lines.push(result.disclaimer);
    lines.push("");
    lines.push(FRAUD_EDUCATION_TIP);

    const application = await this._getOrCreateApplication(user);
    application.pathway_id = pathway.id;
    if (APPLICATION_STAGE_ORDER.indexOf(application.stage) < APPLICATION_STAGE_ORDER.indexOf("pathway_selection")) {
      application.stage = "pathway_selection";
    }
    await application.save();
    await this._upsertLead(user, profile, assessment);

    conversation.context = { ...conversation.context, pathway_id: pathway.id };
    conversation.state = "assessment_menu";
    await conversation.save();

    if (alreadyHasNavigate) {
      await this._send(user, conversation, lines.join("\n"), ASSESSMENT_MENU_OPTIONS);
      return;
    }

    lines.push("");
    lines.push(
      "Ready to go deeper? *MIGRA Navigate* gives you a full personalised pathway, " +
        "eligibility analysis, document guidance and a step-by-step roadmap."
    );
    await this._send(user, conversation, lines.join("\n"));
    await this._requireTier(user, conversation, "navigate", {
      purpose: "MIGRA Navigate — deeper migration pathway analysis", pendingAction: null,
    });
  }

  // ------------------------------------------------------------------ //
  // MIGRA Navigate — post-payment deep assessment, pathway shortlist, roadmap
  // ------------------------------------------------------------------ //

  /** Stage 1 (welcome + profile retrieval). `pendingAction` carries over whatever the person
   * originally paid Navigate to unlock ("consultation"/"track_application"/null) — honored
   * once the real Navigate onboarding finishes (see _enterNavigateMenu) rather than dropped,
   * so paying specifically to "Speak to an Expert" still ends there, just via the fuller
   * experience now instead of skipping straight past it. */
  async _startNavigateOnboarding(user, conversation, pendingAction = null) {
    const profile = await this._getOrCreateProfile(user);
    if (!profile.navigate_started_at) {
      profile.navigate_started_at = new Date();
      await profile.save();
    }
    await this._getOrCreateApplication(user);

    await this._send(
      user, conversation,
      "Welcome to MIGRA Navigate! 🎉 Your payment is confirmed, and we're ready to help you " +
        "move beyond exploring possibilities to building a migration pathway tailored to you."
    );

    const summary = ["Here's what we already have from your Discover profile:"];
    if (user.name) summary.push(`• Name: ${user.name}`);
    if (profile.destination_country) summary.push(`• Destination: ${profile.destination_country}`);
    if (profile.migration_reason) summary.push(`• Goal: ${profile.migration_reason}`);
    if (profile.occupation) summary.push(`• Occupation: ${profile.occupation}`);
    if (profile.education) summary.push(`• Education: ${profile.education}`);
    if (profile.experience_years != null) summary.push(`• Experience: ${profile.experience_years} years`);
    if (profile.timeline) summary.push(`• Timeline: ${profile.timeline.replaceAll("_", " ")}`);
    if (profile.financial_readiness) summary.push(`• Budget: ${profile.financial_readiness}`);
    await this._send(user, conversation, summary.join("\n"));

    conversation.context = { ...conversation.context, flow: "navigate", navigate_pending_action: pendingAction };
    conversation.state = "navigate_profile_update";
    await conversation.save();
    await this._send(
      user, conversation,
      "Before we go deeper — has anything changed since you completed Discover? New " +
        "qualifications, work experience, language test results, or changes in your finances " +
        'or family situation? Reply with details, or just "No changes".'
    );
  }

  /** Also the re-entry point for the Navigate menu's "Update my profile" option — in that case
   * everything's already confirmed/assessed once, so after capturing any update this just
   * flows into _askNextNavigateQuestion finding nothing new to ask and refreshing the pathway
   * shortlist, which is the right outcome for "I updated something, show me what changed." */
  async _handleNavigateProfileUpdate(user, conversation, text) {
    const profile = await this._getOrCreateProfile(user);
    const noChangeRe = /^(no|none|no changes?|nothing|all good|nope)[\s.!]*$/i;

    if (isGreeting(text)) {
      await this._send(
        user, conversation,
        'Has anything changed since Discover? Reply with details, or just "No changes".'
      );
      return;
    }

    if (!noChangeRe.test(text.trim())) {
      const extracted = await understand(this.llmClient, text);
      await this._maybeEscalate(user, conversation, text, extracted);
      const updatedFields = [];
      for (const fieldName of [
        "destination_country", "occupation", "education", "experience_years",
        "age", "language_ability", "family_status", "timeline",
      ]) {
        const value = extracted[fieldName];
        if (value != null && value !== "") {
          profile[fieldName] = value;
          updatedFields.push(fieldName);
        }
      }
      if (updatedFields.length) {
        await profile.save();
        await this._send(user, conversation, `Got it — updated: ${updatedFields.join(", ").replaceAll("_", " ")}.`);
      }
    }

    profile.navigate_profile_confirmed = true;
    await profile.save();
    await this._startNavigateAssessment(user, conversation, profile);
  }

  async _startNavigateAssessment(user, conversation, profile) {
    conversation.state = "navigate_assessment";
    await conversation.save();
    await this._askNextNavigateQuestion(user, conversation, profile);
  }

  async _askNextNavigateQuestion(user, conversation, profile) {
    for (const q of flows.NAVIGATE_SECTIONS) {
      if (q.skipIf && q.skipIf(profile)) continue;
      const target = q.target === "user" ? user : profile;
      if (target[q.field_name] == null) {
        conversation.context = { ...conversation.context, flow: "navigate", current_field: q.field_name };
        await conversation.save();
        await this._send(user, conversation, q.prompt, q.options);
        return;
      }
    }
    await this._buildPathwayShortlist(user, conversation, profile);
  }

  /** Stage 2 (deep assessment) — structurally mirrors _handleDiscoverIntake but walks
   * NAVIGATE_SECTIONS instead; kept as a separate function rather than sharing code with the
   * already-verified, live Discover handler to avoid any regression risk there. */
  async _handleNavigateAssessment(user, conversation, text, interactiveId) {
    const profile = await this._getOrCreateProfile(user);
    const fieldName = conversation.context.current_field;
    const q = flows.NAVIGATE_SECTIONS.find((f) => f.field_name === fieldName);
    if (!q) {
      await this._askNextNavigateQuestion(user, conversation, profile);
      return;
    }

    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await conversation.save();
      await this._send(user, conversation, q.prompt, q.options);
      return;
    }

    let value = null;
    if (q.options.length) {
      const optIdx = resolveSelection(text, interactiveId, q.options);
      if (optIdx !== null) value = q.parser(q.options[optIdx]);
    }
    if (value === null) value = q.parser(text);

    if (value === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        `The user is going through MigraTech Navigate's deep assessment and is being asked: ` +
          `"${q.prompt}" — their reply didn't give a usable answer to that specific question.`
      );
      await this._send(user, conversation, (acknowledged ? "" : "Sorry, I didn't quite catch that. ") + q.prompt, q.options);
      return;
    }

    if (q.validate) {
      const { valid } = await this.llmClient.validateAnswer(q.prompt, text);
      if (!valid) {
        conversation.fallback_count += 1;
        await conversation.save();
        await this._send(user, conversation, "Hmm, that doesn't quite look like an answer to this — " + q.prompt, q.options);
        return;
      }
    }

    const target = q.target === "user" ? user : profile;
    target[q.field_name] = value;
    await target.save();
    conversation.fallback_count = 0;
    await conversation.save();

    if (q.field_name === "offer_legitimacy_confirmed" && value === false) {
      // Fake job/admission offers are an explicitly named fraud pattern elsewhere in this
      // codebase (escalation.js's FRAUD_REPORT_KEYWORDS) — same silent staff-flag pattern as
      // the asylum-reason trigger: the bot keeps going, staff just get visibility.
      await this._escalate(conversation, "User has not independently verified their stated job/admission offer — possible fraud risk, needs review.");
    }

    await this._askNextNavigateQuestion(user, conversation, profile);
  }

  /** Stage 3 (global pathway matching) — real data only. If the person is destination-flexible
   * (or said "several"/"open" on destination), searches every seeded country for their
   * category and ranks whatever real matches actually exist (today: up to 5, since the
   * knowledge base has exactly one pathway per country+category); otherwise just their one
   * stated country+category, same as _bestMatchingPathway already does for Discover. Never
   * fabricates a country/pathway that isn't actually in the knowledge base — cost/timeline
   * fields are shown exactly as they are in the data (today that's always a "confirm with a
   * specialist" placeholder, not invented numbers). Also reachable directly from the Navigate
   * menu's "My recommended pathways" to recompute a fresh shortlist. */
  async _buildPathwayShortlist(user, conversation, profile) {
    if (!profile.destination_country && profile.destination_countries) {
      profile.destination_country = profile.destination_countries.split(/,| and |\/|;/i)[0].trim();
      await profile.save();
    }

    const category = profile.migration_objective;
    const flexible =
      profile.destination_flexibility === "very_flexible" ||
      profile.destination_flexibility === "somewhat_flexible" ||
      profile.has_destination_in_mind === "several" ||
      profile.has_destination_in_mind === "open";

    let pathways = [];
    if (flexible) {
      const countries = await listCountries();
      const perCountry = await Promise.all(countries.map((c) => getPathwaysForCountry(c.name, category)));
      pathways = perCountry.flat();
    } else if (profile.destination_country) {
      pathways = await getPathwaysForCountry(profile.destination_country, category);
      if (!pathways.length) {
        pathways = await searchPathways(`${category || ""} ${profile.destination_country}`.trim());
      }
    }

    if (!pathways.length) {
      await this._send(
        user, conversation,
        "I don't have a specific real pathway on file yet for your current goal/destination — " +
          "a MigraTech specialist will put together real options for you directly."
      );
      await this._escalate(conversation, "Navigate pathway shortlist found zero real matches — needs specialist review.");
      await this._enterNavigateMenu(user, conversation);
      return;
    }

    const RESULT_RANK = { potentially_suitable: 0, more_information_required: 1, likely_not_suitable: 2 };
    const scored = pathways
      .map((pathway) => ({ pathway, assessment: assess(profile, pathway) }))
      .sort((a, b) => {
        const rankDiff = RESULT_RANK[a.assessment.result] - RESULT_RANK[b.assessment.result];
        if (rankDiff !== 0) return rankDiff;
        return `${a.pathway.country.name} ${a.pathway.name}`.localeCompare(`${b.pathway.country.name} ${b.pathway.name}`);
      });

    const lines = [
      "Your MIGRA Navigate Pathway Shortlist 🎯", "",
      `${scored.length} real option${scored.length === 1 ? "" : "s"} based on your profile:`,
    ];
    for (const [i, { pathway, assessment }] of scored.entries()) {
      lines.push("", `${i + 1}. ${pathway.country.name} — ${pathway.name}`);
      lines.push(`Eligibility: ${assessment.result.replaceAll("_", " ")}`);
      if (assessment.reasons.length) lines.push(...assessment.reasons.map((r) => `   • ${r}`));
      if (pathway.requirements?.length) lines.push(`Key requirements: ${pathway.requirements.join("; ")}`);
      lines.push(`Cost & timeline: ${pathway.government_fees || "to be confirmed by a specialist"}`);
      if (pathway.is_verified_content && pathway.source_url) {
        const verifiedDate = pathway.last_verified_at ? pathway.last_verified_at.toISOString().slice(0, 10) : "unknown";
        lines.push(`Source: ${pathway.source_url} (verified ${verifiedDate})`);
      } else {
        lines.push("Source: not yet independently verified — a specialist will confirm current requirements.");
      }
    }
    lines.push(
      "",
      "These are promising options based on what you've told us, not confirmed eligibility — " +
        "final decisions always rest with the relevant government, institution or employer."
    );
    await this._send(user, conversation, lines.join("\n"));

    for (const { pathway, assessment } of scored) {
      await EligibilityAssessment.create({
        user_id: user.id, pathway_id: pathway.id, result: assessment.result,
        reasons: assessment.reasons, pathway_version: pathway.version,
      });
    }
    await this._upsertLead(user, profile, null);

    if (scored.length > 1) {
      // Genuine choice exists — ask rather than silently picking for them (the spec's own
      // "ask the client to select a preferred pathway or request a comparison"). A single-
      // result shortlist skips this (nothing to meaningfully choose between).
      conversation.context = { ...conversation.context, shortlist_pathway_ids: scored.map((s) => s.pathway.id) };
      conversation.state = "navigate_pathway_selection";
      await conversation.save();
      await this._send(
        user, conversation,
        `Which of these would you like to move forward with? Reply with a number (1-${scored.length}), ` +
          'or reply "compare" and two numbers (e.g. "compare 1 3") for a side-by-side.'
      );
      return;
    }

    const application = await this._getOrCreateApplication(user);
    application.pathway_id = scored[0].pathway.id;
    if (APPLICATION_STAGE_ORDER.indexOf(application.stage) < APPLICATION_STAGE_ORDER.indexOf("pathway_selection")) {
      application.stage = "pathway_selection";
    }
    await application.save();

    await this._enterNavigateMenu(user, conversation);
  }

  /** Handles the reply to _buildPathwayShortlist's "which one?" prompt — a plain number picks
   * one (sets Application.pathway_id to their actual choice, not an auto-pick), "compare N M"
   * sends a short side-by-side using the same real per-pathway data already shown. */
  async _handleNavigatePathwaySelection(user, conversation, text) {
    const ids = conversation.context?.shortlist_pathway_ids || [];
    const lowered = text.trim().toLowerCase();

    const compareMatch = lowered.match(/^compare\s+(\d+)\s+(\d+)$/);
    if (compareMatch) {
      const [a, b] = [parseInt(compareMatch[1], 10) - 1, parseInt(compareMatch[2], 10) - 1];
      if (a >= 0 && a < ids.length && b >= 0 && b < ids.length && a !== b) {
        const [pathwayA, pathwayB] = await Promise.all([
          Pathway.findByPk(ids[a], { include: [{ model: Country, as: "country" }] }),
          Pathway.findByPk(ids[b], { include: [{ model: Country, as: "country" }] }),
        ]);
        const profile = await this._getOrCreateProfile(user);
        const lines = ["Pathway Comparison", ""];
        for (const [idx, pathway] of [[a, pathwayA], [b, pathwayB]]) {
          const assessment = assess(profile, pathway);
          lines.push(`${idx + 1}. ${pathway.country.name} — ${pathway.name}`);
          lines.push(`   Eligibility: ${assessment.result.replaceAll("_", " ")}`);
          if (pathway.requirements?.length) lines.push(`   Key requirements: ${pathway.requirements.join("; ")}`);
          lines.push("");
        }
        lines.push(`Reply with a number (1-${ids.length}) to move forward with one, or "compare" two others.`);
        await this._send(user, conversation, lines.join("\n"));
        return;
      }
    }

    const idx = parseInt(text.trim(), 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= ids.length) {
      await this._send(
        user, conversation,
        `Please reply with a number (1-${ids.length}) to pick one, or "compare" and two numbers ` +
          'for a side-by-side (e.g. "compare 1 3").'
      );
      return;
    }

    const pathway = await Pathway.findByPk(ids[idx]);
    const application = await this._getOrCreateApplication(user);
    application.pathway_id = pathway.id;
    if (APPLICATION_STAGE_ORDER.indexOf(application.stage) < APPLICATION_STAGE_ORDER.indexOf("pathway_selection")) {
      application.stage = "pathway_selection";
    }
    await application.save();
    await this._send(user, conversation, `Got it — we'll build your roadmap around ${pathway.name}.`);
    await this._enterNavigateMenu(user, conversation);
  }

  /** Enters (or returns to) the Navigate menu state. If the person originally paid Navigate to
   * unlock a specific thing ("Speak to an Expert" / "Track My Application"), honors that intent
   * once here rather than silently dropping it — see _startNavigateOnboarding's comment. */
  async _enterNavigateMenu(user, conversation) {
    conversation.state = "navigate_menu";
    await conversation.save();

    const pendingAction = conversation.context?.navigate_pending_action;
    if (pendingAction) {
      conversation.context = { ...conversation.context, navigate_pending_action: null };
      await conversation.save();
      if (pendingAction === "consultation") {
        await this._offerConsultation(user, conversation);
        return;
      }
      if (pendingAction === "track_application") {
        if (await this._handleTrackApplication(user, conversation)) await this._sendNavigateMenu(user, conversation);
        return;
      }
    }
    await this._sendNavigateMenu(user, conversation);
  }

  async _sendNavigateMenu(user, conversation, prefix = null) {
    const hint = await this._navigateStageHint(user);
    const parts = [prefix, hint, "What would you like to do?"].filter(Boolean);
    await this._send(user, conversation, parts.join("\n\n"), flows.NAVIGATE_MENU_OPTIONS);
  }

  /** Computed fresh from real state every time the menu renders (same approach as the
   * roadmap) — a light nudge toward whatever's actually the next real step, not a separate
   * menu system. Returns null once there's nothing specific left to nudge about. */
  async _navigateStageHint(user) {
    const application = await Application.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!application) return null;
    if (!application.pathway_id) return '📌 Pick a pathway to keep moving — check "My recommended pathways".';

    const pathway = await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] });
    if (!pathway) return null;
    const documents = await Document.findAll({ where: { user_id: user.id } });
    const checklist = generateChecklist(pathway, documents);
    const missing = checklist.items.filter((i) => i.status === "missing").length;
    if (missing > 0) return `📌 You still have ${missing} document${missing === 1 ? "" : "s"} to upload — check "My documents".`;
    return null;
  }

  async _handleNavigateMenu(user, conversation, text, interactiveId) {
    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await conversation.save();
      await this._sendNavigateMenu(user, conversation);
      return;
    }

    const idx = resolveSelection(text, interactiveId, flows.NAVIGATE_MENU_OPTIONS);
    if (idx === null) {
      const lowered = text.toLowerCase();
      if (/progress|roadmap|what.*next/.test(lowered)) {
        await this._renderRoadmap(user, conversation);
        return;
      }
      if (/\b(i have|i've got|already have|have my|have the|got my|ready)\b/i.test(text) && await this._tryMarkDocumentDeclared(user, conversation, text)) {
        return;
      }
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        "The user is at MigraTech Navigate's main menu and just replied with something that isn't one of the menu options."
      );
      await this._sendNavigateMenu(user, conversation, acknowledged ? null : "Sorry, I didn't quite catch that.");
      return;
    }

    conversation.fallback_count = 0;
    await conversation.save();
    const option = flows.NAVIGATE_MENU_OPTIONS[idx];
    const profile = await this._getOrCreateProfile(user);

    if (option === "My migration assessment") {
      await this._renderNavigateAssessmentSummary(user, conversation, profile);
    } else if (option === "My recommended pathways") {
      await this._buildPathwayShortlist(user, conversation, profile);
    } else if (option === "My documents") {
      await this._handleNavigateDocumentsRequest(user, conversation, profile);
    } else if (option === "My migration roadmap") {
      await this._renderRoadmap(user, conversation);
    } else if (option === "Ask MIGRA") {
      conversation.state = "faq_waiting_question";
      await conversation.save();
      await this._send(user, conversation, "What would you like to know?");
    } else if (option === "Find a verified expert" || option === "Talk to human support") {
      await this._offerConsultation(user, conversation);
    } else if (option === "Update my profile") {
      conversation.context = { ...conversation.context, flow: "navigate" };
      conversation.state = "navigate_profile_update";
      await conversation.save();
      await this._send(user, conversation, 'What\'s changed? Tell me in a sentence or two, or reply "No changes" to go back.');
    }
  }

  async _renderNavigateAssessmentSummary(user, conversation, profile) {
    const lines = ["Your Migration Assessment", ""];
    if (profile.destination_country) lines.push(`Destination: ${profile.destination_country}`);
    if (profile.migration_reason) lines.push(`Goal: ${profile.migration_reason}`);
    if (profile.occupation) lines.push(`Occupation: ${profile.occupation}`);
    if (profile.education) lines.push(`Education: ${profile.education}`);
    if (profile.experience_years != null) lines.push(`Experience: ${profile.experience_years} years`);
    if (profile.language_ability) lines.push(`Languages: ${profile.language_ability}`);
    if (profile.target_salary) lines.push(`Target salary: ${profile.target_salary}`);
    if (profile.financial_readiness) lines.push(`Budget: ${profile.financial_readiness}`);
    if (profile.timeline) lines.push(`Timeline: ${profile.timeline.replaceAll("_", " ")}`);
    if (profile.visa_refused_before) lines.push(`Previous visa refusal: Yes (${profile.visa_refusal_country || "details on file"})`);
    if (lines.length === 2) lines.push("No profile details on file yet.");
    await this._send(user, conversation, lines.join("\n"));
    await this._sendNavigateMenu(user, conversation);
  }

  /** "My documents" from the Navigate menu — same checklist generator/renderer as Discover's
   * _handleDocumentsRequest, but returns to the Navigate menu afterward instead of the
   * Discover main menu (kept separate from _handleDocumentsRequest for that reason). */
  async _handleNavigateDocumentsRequest(user, conversation, profile) {
    const application = await this._getOrCreateApplication(user);
    const pathway = application.pathway_id
      ? await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] })
      : profile.migration_objective
        ? await this._bestMatchingPathway(profile, profile.migration_objective)
        : null;
    if (pathway) {
      const documents = await Document.findAll({ where: { user_id: user.id } });
      const checklist = generateChecklist(pathway, documents);
      await this._send(
        user, conversation,
        renderChecklistWhatsappText(checklist) +
          '\n\nAlready have one of these but haven\'t sent it? Reply with the document name ' +
          'and "I have it" to mark it, or just send the file directly.'
      );
    } else {
      await this._send(user, conversation, 'I don\'t have a specific pathway on file yet — check "My recommended pathways" first.');
    }
    await this._enterNavigateMenu(user, conversation);
  }

  /** "I have my passport" style free-text from the Navigate menu — matches against the active
   * pathway's real document list (case-insensitive substring) and marks that Document row
   * "declared" (a real third evidence tier: they say they have it, nothing's been uploaded).
   * Returns false (caller falls through to the generic fallback) if nothing matched, so a
   * genuinely unrelated "I have a question" doesn't get silently swallowed. */
  async _tryMarkDocumentDeclared(user, conversation, text) {
    const application = await Application.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!application?.pathway_id) return false;
    const pathway = await Pathway.findByPk(application.pathway_id);
    if (!pathway?.documents?.length) return false;

    const lowered = text.toLowerCase();
    const matchedName = pathway.documents.find((docName) => lowered.includes(docName.toLowerCase()));
    if (!matchedName) return false;

    let document = await Document.findOne({ where: { user_id: user.id, document_type: matchedName } });
    if (!document) document = Document.build({ user_id: user.id, document_type: matchedName });
    if (["uploaded", "verified"].includes(document.status)) {
      await this._send(
        user, conversation,
        `Good news — "${matchedName}" is already ${document.status === "verified" ? "verified" : "uploaded and awaiting review"}.`
      );
      await this._enterNavigateMenu(user, conversation);
      return true;
    }
    document.status = "declared";
    await document.save();
    await this._send(user, conversation, `Noted — I've marked "${matchedName}" as ready. Send the file whenever you're able to.`);
    await this._enterNavigateMenu(user, conversation);
    return true;
  }

  /** Stage 5 (personalised roadmap) — tasks are derived fresh from real state (profile
   * completeness, document checklist, consultation booking, application stage) every time
   * this is viewed, not hand-authored busy-work, so it always reflects the actual case record.
   * Also the target of "show my progress"/"what should I do next" free-text triggers from the
   * Navigate menu. Writes the result into Application.milestones (previously unused). */
  async _renderRoadmap(user, conversation) {
    const profile = await this._getOrCreateProfile(user);
    const application = await this._getOrCreateApplication(user);
    const documents = await Document.findAll({ where: { user_id: user.id } });
    const pathway = application.pathway_id
      ? await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] })
      : null;
    const consultation = await ConsultationBooking.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });

    const checklist = pathway ? generateChecklist(pathway, documents) : { items: [] };
    const missingItems = checklist.items.filter((i) => i.status === "missing");
    const awaitingReview = checklist.items.filter((i) => i.status === "uploaded").length;
    const pastStage = (stage) => APPLICATION_STAGE_ORDER.indexOf(application.stage) > APPLICATION_STAGE_ORDER.indexOf(stage);
    const sourceLink = pathway && pathway.is_verified_content && pathway.source_url ? pathway.source_url : null;

    const tasks = [
      {
        phase: "Confirm eligibility", label: "Complete your migration profile",
        status: profile.navigate_profile_confirmed ? "done" : "pending",
        detail: profile.navigate_profile_confirmed ? null : "Reply \"Update my profile\" from the menu to confirm/update your details.",
      },
      {
        phase: "Confirm eligibility", label: "Review your recommended pathway(s)",
        status: application.pathway_id ? "done" : "pending",
        detail: application.pathway_id ? (pathway ? `Selected: ${pathway.country.name} — ${pathway.name}` : null) : "Check \"My recommended pathways\" from the menu.",
        link: application.pathway_id ? sourceLink : null,
      },
      {
        phase: "Prepare evidence",
        label: `Upload required documents${checklist.items.length ? ` (${missingItems.length} still missing)` : ""}`,
        status: !checklist.items.length ? "pending" : missingItems.length === 0 ? "done" : missingItems.length < checklist.items.length ? "in_progress" : "pending",
        detail: missingItems.length ? `Still needed: ${missingItems.map((i) => i.name).join(", ")}` : null,
      },
    ];
    if (awaitingReview) {
      tasks.push({ phase: "Prepare evidence", label: `${awaitingReview} document(s) awaiting specialist review`, status: "in_progress", detail: null });
    }
    tasks.push({
      phase: "Pursue the pathway", label: "Speak with a MigraTech specialist",
      status: consultation ? "done" : "pending",
      detail: consultation ? null : "Choose \"Find a verified expert\" from the menu to book a call.",
    });
    tasks.push({
      phase: "Prepare for application & relocation",
      label: "Final application preparation",
      status: application.stage === "application_preparation" || pastStage("application_preparation") ? "done" : "pending",
      detail: application.stage === "application_preparation" || pastStage("application_preparation")
        ? null
        : "Opens once your documents are verified and you've spoken with a specialist.",
    });

    application.milestones = { phase: application.stage, tasks, generated_at: new Date().toISOString() };
    await application.save();

    const STATUS_EMOJI = { done: "✅", in_progress: "🟡", pending: "⬜" };
    const lines = ["Your Migration Roadmap", ""];
    let currentPhase = null;
    for (const t of tasks) {
      if (t.phase !== currentPhase) {
        lines.push("", `*${t.phase}*`);
        currentPhase = t.phase;
      }
      lines.push(`${STATUS_EMOJI[t.status]} ${t.label}`);
      if (t.detail) lines.push(`   ${t.detail}`);
      if (t.link) lines.push(`   Source: ${t.link}`);
    }
    await this._send(user, conversation, lines.join("\n"));
    await this._enterNavigateMenu(user, conversation);
  }

  // ------------------------------------------------------------------ //
  // MIGRA RELOCATE — paid execution/case-management tier. Reuses real shared primitives
  // (checklist generation, the consultation flow, _handleTrackApplication, case messaging)
  // but keeps its own menu/state handlers separate from Navigate's, same reasoning as
  // Discover/Navigate's own split: protects the already-verified live flows from regression.
  // ------------------------------------------------------------------ //

  async _startRelocateOnboarding(user, conversation, pendingAction = null) {
    await this._getOrCreateProfile(user);
    const application = await this._getOrCreateApplication(user);
    if (!application.relocate_started_at) {
      application.relocate_started_at = new Date();
      await application.save();
    }

    await this._send(
      user, conversation,
      "Congratulations on taking the next step with MIGRA! 🎉\n\n" +
        "Your Navigate assessment helped us identify your preferred migration pathway. With " +
        "MIGRA Relocate, we'll help you coordinate the next steps, manage outstanding " +
        "requirements, and track your journey from preparation towards departure and, where " +
        "included, settlement."
    );

    conversation.context = { ...conversation.context, flow: "relocate", relocate_pending_action: pendingAction };
    conversation.state = "relocate_phase_question";
    await conversation.save();
    await this._send(
      user, conversation,
      "Let's set up your Relocate case. Where are you in your migration journey?",
      flows.RELOCATE_PHASE_OPTIONS
    );
  }

  async _handleRelocatePhaseQuestion(user, conversation, text, interactiveId) {
    if (isGreeting(text)) {
      await this._send(user, conversation, "Where are you in your migration journey?", flows.RELOCATE_PHASE_OPTIONS);
      return;
    }

    const idx = resolveSelection(text, interactiveId, flows.RELOCATE_PHASE_OPTIONS);
    if (idx === null) {
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        "The user is being asked where they are in their migration journey (a 7-option list) " +
          "during MIGRA Relocate onboarding and replied with something that isn't one of the options."
      );
      await this._send(
        user, conversation,
        (acknowledged ? "" : "Sorry, I didn't quite catch that. ") + "Where are you in your migration journey?",
        flows.RELOCATE_PHASE_OPTIONS
      );
      return;
    }

    conversation.fallback_count = 0;
    await conversation.save();

    const application = await this._getOrCreateApplication(user);
    const phase = flows.RELOCATE_PHASE_CODES[idx];
    application.relocate_phase = phase;
    await application.save();

    // Cheap, real staff signal: if the client's own self-report implies they're further along
    // than the recorded case stage, that's worth a human checking — not something the bot
    // should silently believe or silently ignore either way.
    const AHEAD_PHASES = new Set(["approved_or_visa", "preparing_to_travel", "arrived_need_settlement"]);
    if (AHEAD_PHASES.has(phase) && APPLICATION_STAGE_ORDER.indexOf(application.stage) < APPLICATION_STAGE_ORDER.indexOf("decision")) {
      await this._escalate(
        conversation,
        "Relocate subscriber self-reports being further along than their recorded case stage — verify and update stage/vendor assignment."
      );
    }

    await this._startRelocatePathwayConfirm(user, conversation);
  }

  async _startRelocatePathwayConfirm(user, conversation) {
    const application = await this._getOrCreateApplication(user);
    const profile = await this._getOrCreateProfile(user);
    const pathway = application.pathway_id
      ? await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] })
      : profile.migration_objective
        ? await this._bestMatchingPathway(profile, profile.migration_objective)
        : null;

    if (!pathway) {
      await this._send(
        user, conversation,
        "I don't have a confirmed pathway on file for your case yet — a MigraTech specialist " +
          "will confirm this with you directly."
      );
      await this._escalate(conversation, "Relocate case has no confirmed pathway on file — needs specialist review.");
      await this._enterRelocateMenu(user, conversation);
      return;
    }

    conversation.state = "relocate_pathway_confirm";
    await conversation.save();
    await this._send(
      user, conversation,
      `Which pathway are we managing? Based on your MIGRA Navigate assessment: *${pathway.country.name} — ${pathway.name}*. Is this still accurate?`,
      flows.RELOCATE_PATHWAY_CONFIRM_OPTIONS
    );
  }

  async _handleRelocatePathwayConfirm(user, conversation, text, interactiveId) {
    const idx = resolveSelection(text, interactiveId, flows.RELOCATE_PATHWAY_CONFIRM_OPTIONS);
    if (idx === null) {
      await this._send(
        user, conversation,
        'Please reply "Yes, that\'s correct" or "No, something\'s changed".',
        flows.RELOCATE_PATHWAY_CONFIRM_OPTIONS
      );
      return;
    }

    if (idx === 1) {
      // Relocate executes an already-chosen pathway — it doesn't re-run Discover/Navigate's
      // matching. A changed pathway is a specialist's call, not an automated re-match.
      await this._send(
        user, conversation,
        "Thanks for flagging that — a MigraTech specialist will review your case and update your pathway directly."
      );
      await this._escalate(conversation, "Relocate subscriber says their pathway has changed — needs specialist review/update.");
    }

    await this._enterRelocateMenu(user, conversation);
  }

  async _enterRelocateMenu(user, conversation) {
    conversation.state = "relocate_menu";
    await conversation.save();

    const pendingAction = conversation.context?.relocate_pending_action;
    if (pendingAction) {
      conversation.context = { ...conversation.context, relocate_pending_action: null };
      await conversation.save();
      if (pendingAction === "track_application") {
        if (await this._handleTrackApplication(user, conversation)) await this._sendRelocateMenu(user, conversation);
        return;
      }
      if (pendingAction === "consultation") {
        await this._offerConsultation(user, conversation);
        return;
      }
    }
    await this._sendRelocateMenu(user, conversation);
  }

  async _sendRelocateMenu(user, conversation, prefix = null) {
    const hint = await this._relocateStageHint(user);
    const parts = [prefix, hint, "What would you like to do?"].filter(Boolean);
    await this._send(user, conversation, parts.join("\n\n"), flows.RELOCATE_MENU_OPTIONS);
  }

  /** Computed fresh from real state every render, same approach as Navigate's
   * _navigateStageHint — a light nudge toward the single most urgent real thing (via the
   * shared findRelocateUrgentItem helper), never a separate stored menu system. */
  async _relocateStageHint(user) {
    const application = await Application.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!application) return null;
    if (!application.vendor_id && !application.pathway_id) return "📌 We're finalising your pathway and specialist match.";

    const pathway = application.pathway_id
      ? await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] })
      : null;
    const documents = await Document.findAll({ where: { user_id: user.id } });
    const item = findRelocateUrgentItem(application, documents, pathway);
    if (!item) return !application.vendor_id ? "📌 We're finalising your specialist match." : null;
    if (item.kind === "missing_documents") return `📌 You still have ${item.names.length} document(s) to upload — check "My Documents".`;
    if (item.kind === "expired_document") return `📌 Your ${item.name} has expired — check "My Documents".`;
    if (item.kind === "inconsistent_document") return `📌 Your ${item.name} needs attention — check "My Documents".`;
    return null;
  }

  async _handleRelocateMenu(user, conversation, text, interactiveId) {
    if (isGreeting(text)) {
      conversation.fallback_count = 0;
      await conversation.save();
      await this._sendRelocateMenu(user, conversation);
      return;
    }

    const idx = resolveSelection(text, interactiveId, flows.RELOCATE_MENU_OPTIONS);
    if (idx === null) {
      const lowered = text.toLowerCase();
      if (/case status|where (is|am) i|my case/.test(lowered)) {
        await this._handleRelocateMyCase(user, conversation);
        return;
      }
      if (/document|checklist|upload/.test(lowered)) {
        await this._handleRelocateDocumentsRequest(user, conversation);
        return;
      }
      if (/application|milestone|progress/.test(lowered)) {
        if (await this._handleTrackApplication(user, conversation)) await this._sendRelocateMenu(user, conversation);
        return;
      }
      if (/expert|agent|specialist/.test(lowered)) {
        await this._handleRelocateExpertMenu(user, conversation);
        return;
      }
      if (/payment|fee|receipt/.test(lowered)) {
        await this._handleRelocateMyPayments(user, conversation);
        return;
      }
      if (/depart|travel|flight/.test(lowered)) {
        await this._handleRelocateDeparturePrep(user, conversation);
        return;
      }
      if (/settle|arriv|housing/.test(lowered)) {
        await this._handleRelocateSettlementGuidance(user, conversation);
        return;
      }
      if (/support|complain/.test(lowered)) {
        await this._offerConsultation(user, conversation);
        return;
      }
      if (/\b(i have|i've got|already have|have my|have the|got my|ready)\b/i.test(text) && await this._tryMarkRelocateDocumentDeclared(user, conversation, text)) {
        return;
      }
      conversation.fallback_count += 1;
      await conversation.save();
      const acknowledged = await this._conversationalNudge(
        user, conversation, text,
        "The user is at MigraTech Relocate's case workspace menu and just replied with something that isn't one of the menu options."
      );
      await this._sendRelocateMenu(user, conversation, acknowledged ? null : "Sorry, I didn't quite catch that.");
      return;
    }

    conversation.fallback_count = 0;
    await conversation.save();
    const option = flows.RELOCATE_MENU_OPTIONS[idx];

    if (option === "My Relocate Case") {
      await this._handleRelocateMyCase(user, conversation);
    } else if (option === "My Documents") {
      await this._handleRelocateDocumentsRequest(user, conversation);
    } else if (option === "My Application") {
      if (await this._handleTrackApplication(user, conversation)) await this._sendRelocateMenu(user, conversation);
    } else if (option === "My Expert") {
      await this._handleRelocateExpertMenu(user, conversation);
    } else if (option === "My Payments") {
      await this._handleRelocateMyPayments(user, conversation);
    } else if (option === "Prepare for Departure") {
      await this._handleRelocateDeparturePrep(user, conversation);
    } else if (option === "Settle at My Destination") {
      await this._handleRelocateSettlementGuidance(user, conversation);
    } else if (option === "Speak to Support") {
      await this._offerConsultation(user, conversation);
    }
  }

  async _handleRelocateMyCase(user, conversation) {
    const application = await this._getOrCreateApplication(user);
    const lines = ["Your Relocate Case", ""];
    lines.push(`Status: ${RELOCATE_STAGE_LABELS[application.stage] || application.stage}`);
    if (application.relocate_phase) {
      lines.push(`You told us: ${flows.RELOCATE_PHASE_LABELS[application.relocate_phase] || application.relocate_phase}`);
    }
    if (application.assigned_specialist) {
      lines.push(`Case owner: ${application.assigned_specialist}`);
    } else if (application.vendor_id) {
      const vendor = await Vendor.findByPk(application.vendor_id);
      lines.push(`Case owner: ${vendor ? (vendor.business_name || vendor.name) : "a MigraTech partner"}`);
    } else {
      lines.push("Case owner: MigraTech staff are handling your case directly — no partner agent needed yet.");
    }
    await this._send(user, conversation, lines.join("\n"));
    await this._sendRelocateMenu(user, conversation);
  }

  /** "My Documents" from the Relocate menu — same checklist generator/renderer Discover/
   * Navigate already use, just returns to the Relocate menu afterward. Deliberately a thin
   * duplicate of _handleNavigateDocumentsRequest rather than a shared call, same reasoning as
   * the rest of this section. */
  async _handleRelocateDocumentsRequest(user, conversation) {
    const application = await this._getOrCreateApplication(user);
    const profile = await this._getOrCreateProfile(user);
    const pathway = application.pathway_id
      ? await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] })
      : profile.migration_objective
        ? await this._bestMatchingPathway(profile, profile.migration_objective)
        : null;
    if (pathway) {
      const documents = await Document.findAll({ where: { user_id: user.id } });
      const checklist = generateChecklist(pathway, documents);
      await this._send(
        user, conversation,
        renderChecklistWhatsappText(checklist) +
          '\n\nAlready have one of these but haven\'t sent it? Reply with the document name ' +
          'and "I have it" to mark it, or just send the file directly.'
      );
    } else {
      await this._send(user, conversation, 'I don\'t have a specific pathway on file yet — check "My Relocate Case" first.');
    }
    await this._enterRelocateMenu(user, conversation);
  }

  /** Parallel duplicate of Navigate's _tryMarkDocumentDeclared — deliberately not shared, same
   * reasoning as the rest of this section (protects the already-verified live Navigate path). */
  async _tryMarkRelocateDocumentDeclared(user, conversation, text) {
    const application = await Application.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!application?.pathway_id) return false;
    const pathway = await Pathway.findByPk(application.pathway_id);
    if (!pathway?.documents?.length) return false;

    const lowered = text.toLowerCase();
    const matchedName = pathway.documents.find((docName) => lowered.includes(docName.toLowerCase()));
    if (!matchedName) return false;

    let document = await Document.findOne({ where: { user_id: user.id, document_type: matchedName } });
    if (!document) document = Document.build({ user_id: user.id, document_type: matchedName });
    if (["uploaded", "verified"].includes(document.status)) {
      await this._send(
        user, conversation,
        `Good news — "${matchedName}" is already ${document.status === "verified" ? "verified" : "uploaded and awaiting review"}.`
      );
      await this._enterRelocateMenu(user, conversation);
      return true;
    }
    document.status = "declared";
    await document.save();
    await this._send(user, conversation, `Noted — I've marked "${matchedName}" as ready. Send the file whenever you're able to.`);
    await this._enterRelocateMenu(user, conversation);
    return true;
  }

  async _handleRelocateExpertMenu(user, conversation) {
    const application = await this._getOrCreateApplication(user);
    if (!application.vendor_id) {
      await this._send(
        user, conversation,
        "You don't have a verified migration professional assigned yet — MigraTech staff are " +
          "matching you with the right partner for your case."
      );
      await this._escalate(conversation, "Relocate subscriber opened My Expert with no vendor assigned yet — needs vendor match.");
      await this._sendRelocateMenu(user, conversation);
      return;
    }

    const vendor = await Vendor.findByPk(application.vendor_id);
    if (!vendor) {
      await this._send(user, conversation, "Your assigned specialist's record couldn't be found — a MigraTech staff member will follow up.");
      await this._escalate(conversation, "Relocate case has a vendor_id with no matching Vendor row.");
      await this._sendRelocateMenu(user, conversation);
      return;
    }

    const lines = [`Your Expert: ${vendor.business_name || vendor.name}`, ""];
    if (vendor.services_offered) lines.push(`Services: ${vendor.services_offered}`);
    if (vendor.countries_covered) lines.push(`Covers: ${vendor.countries_covered}`);

    await markCaseMessagesRead(application.id, "user");
    const messages = await listCaseMessages(application.id);
    const recent = messages.slice(-10);
    if (recent.length) {
      lines.push("", "Recent messages:");
      for (const m of recent) {
        lines.push(`${m.sender_type === "vendor" ? vendor.name : "You"}: ${m.body}`);
      }
    }
    lines.push("", `Type a message to send to ${vendor.name}, or reply "menu" to go back.`);
    await this._send(user, conversation, lines.join("\n"));

    conversation.context = { ...conversation.context, relocate_case_id: application.id };
    conversation.state = "relocate_expert_chat";
    await conversation.save();
  }

  async _handleRelocateExpertChat(user, conversation, text) {
    const lowered = text.trim().toLowerCase();
    if (["menu", "back"].includes(lowered)) {
      await this._enterRelocateMenu(user, conversation);
      return;
    }

    const application = await this._getOrCreateApplication(user);
    if (!application.vendor_id) {
      await this._send(user, conversation, "Your specialist assignment has changed — a MigraTech staff member will follow up.");
      await this._escalate(conversation, "Relocate case lost its vendor assignment mid-chat.");
      await this._enterRelocateMenu(user, conversation);
      return;
    }
    const vendor = await Vendor.findByPk(application.vendor_id);

    await postCaseMessage(application.id, "user", user.id, text);
    await this._send(
      user, conversation,
      `Sent to ${vendor ? vendor.name : "your specialist"} — they'll see it next time they check their dashboard. ` +
        'Reply "menu" to go back.'
    );
  }

  /** Deliberately does not surface Commission data (MigraTech's internal payout to the
   * assigned vendor) — that's not the client's business, only their own real Payment rows. */
  async _handleRelocateMyPayments(user, conversation) {
    const payments = await Payment.findAll({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
    if (!payments.length) {
      await this._send(user, conversation, "No payments on file yet.");
    } else {
      const lines = ["Your Payments", ""];
      for (const p of payments) {
        const date = (p.paid_at || p.created_at).toISOString().slice(0, 10);
        lines.push(`${date} — ${p.purpose}: ${p.currency} ${Number(p.amount).toLocaleString()} (${p.status})`);
      }
      lines.push(
        "",
        "Any additional fees for a specific verified professional's services are arranged " +
          'directly with your specialist — see "My Expert" for details.'
      );
      await this._send(user, conversation, lines.join("\n"));
    }
    await this._sendRelocateMenu(user, conversation);
  }

  /** Static, hand-authored, pathway-agnostic copy — deliberately not country-specific (the
   * knowledge base has no real local-service/travel data to draw on), explicitly framed as
   * general guidance rather than fabricated destination facts. */
  async _handleRelocateDeparturePrep(user, conversation) {
    await this._send(
      user, conversation,
      "Prepare for Departure\n\n" +
        "A general checklist to start working through:\n" +
        "• Confirm your flight booking and check passport validity against your travel date\n" +
        "• Notify your bank of international travel and sort out local currency/cards\n" +
        "• Arrange travel insurance\n" +
        "• Keep copies (physical and digital) of your passport, visa, and key documents, stored separately from the originals\n" +
        "• Share your travel itinerary with family\n\n" +
        "This is general guidance — a MigraTech specialist will tailor this to your specific pathway and destination."
    );
    await this._sendRelocateMenu(user, conversation);
  }

  async _handleRelocateSettlementGuidance(user, conversation) {
    await this._send(
      user, conversation,
      "Settle at My Destination\n\n" +
        "General areas to plan for once you arrive:\n" +
        "• Local registration/residency formalities\n" +
        "• Opening a local bank account\n" +
        "• A local SIM/phone plan\n" +
        "• Temporary and longer-term housing\n" +
        "• School or healthcare registration, if relevant to your family\n" +
        "• Local community or diaspora groups\n\n" +
        "This is general guidance — a MigraTech specialist will provide referrals specific to your destination."
    );
    await this._sendRelocateMenu(user, conversation);
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
      await this._startDiscoverFlow(user, conversation);
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
      purpose: "MIGRA Relocate — application tracking",
      pendingAction: "track_application",
    });
    if (!unlocked) return false;

    const documents = await Document.findAll({ where: { user_id: user.id } });
    const pathway = application.pathway_id ? await Pathway.findByPk(application.pathway_id) : null;
    const requiredDocs = pathway ? (pathway.documents || []).length : 0;
    const uploadedDocs = documents.filter((d) => ["uploaded", "verified"].includes(d.status)).length;
    const docPct = requiredDocs ? Math.round((100 * uploadedDocs) / requiredDocs) : 0;

    // RELOCATE_STAGE_ORDER, not the bare APPLICATION_STAGE_ORDER — this function is already
    // 100% relocate-gated above, so rendering the fuller pre_departure/settlement pipeline
    // here is safe and doesn't affect any non-Relocate caller (there are none).
    const currentIndex = RELOCATE_STAGE_ORDER.indexOf(application.stage);
    const lines = ["Migration Journey", ""];
    RELOCATE_STAGE_ORDER.forEach((stage, i) => {
      const label = RELOCATE_STAGE_LABELS[stage];
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
    await this._maybeEscalate(user, conversation, text, extracted);

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
      profile.migration_objective = extracted.migration_objective;
      await profile.save();
      const destClause = profile.destination_country ? ` to ${profile.destination_country}` : "";
      await this._send(
        user, conversation,
        `Great, I can help you explore legitimate migration pathways${destClause}. ` +
          "Let's get a bit more detail."
      );
      await this._startDiscoverFlow(user, conversation);
      return true;
    }

    if (updatedFields.length && profile.destination_country) {
      await this._send(
        user, conversation,
        "Great, I can help you explore legitimate migration pathways to " +
          `${profile.destination_country}. Let's get started.`
      );
      await this._startDiscoverFlow(user, conversation);
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------------ //
  // Cross-cutting helpers
  // ------------------------------------------------------------------ //

  /** Used wherever a message doesn't match any menu option / parseable answer and there's no
   * more specific shortcut to try (a bare "no", "why", "not sure", etc.) — gets a short,
   * natural AI acknowledgment of what the user actually said instead of jumping straight to
   * a canned "sorry, pick an option" (that generic text is still sent right after by the
   * caller, so navigation never breaks even when this returns false). Returns true if it sent
   * something, so callers can skip their own canned prefix. Silently does nothing if AI isn't
   * configured/rate-limited/erroring or its reply trips a guardrail. */
  async _conversationalNudge(user, conversation, text, situationContext) {
    const reply = await this.llmClient.chatReply(text, situationContext);
    if (!reply) return false;

    const banned = findBannedClaim(reply);
    if (banned) {
      logger.warn({ banned }, "Blocked banned claim in conversational fallback reply");
      return false;
    }

    await this._send(user, conversation, reply);
    return true;
  }

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
      // Routine trigger, no longer escalated (2026-08-28) — stay honest about not knowing
      // rather than guessing, but keep going instead of handing off.
      await this._send(user, conversation, LOW_CONFIDENCE_MESSAGE);
      return true;
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
        `"${purpose}" is part of MigraTech's Relocate package — pricing is tailored to your ` +
          `specific migration pathway, typically starting around ₦${settings.relocateReferencePriceNgn.toLocaleString()} ` +
          `(~$${settings.relocateReferencePriceUsdDisplay}). A MigraTech specialist will follow up ` +
          'with your exact quote and payment link. Reply "menu" anytime to go back for now.'
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
        `To unlock "${purpose}" (₦${settings.navigatePriceNgn.toLocaleString()} / ` +
          `~$${settings.navigatePriceUsdDisplay}), complete payment here:\n${authorization_url}\n\n` +
          'I\'ll confirm automatically as soon as it goes through — message me anytime to ' +
          'check, or reply "menu" to go back for now.'
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
        `Still waiting on payment for "${purpose || "your MIGRA Navigate package"}" — complete ` +
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

    // Everything the bot does lives in this WhatsApp conversation with no way to review it
    // outside the chat history — the web portal is the actual place to track progress/
    // documents/payments over time, but nothing ever pointed a paying customer at it.
    // user.password_hash is what actually distinguishes "has a portal account" from "just a
    // WhatsApp contact" (see portal/service.js) — registering with this same WhatsApp number
    // claims this exact row (payment, profile, conversation history included), so this is a
    // real account, not a fresh empty one.
    if (!user.password_hash) {
      await this._send(
        user, conversation,
        "One more thing — you can create a free account at https://migra.ng/register using " +
          "this same WhatsApp number to track this payment, your documents, and your " +
          "migration progress online anytime, not just here in chat."
      );
    } else {
      await this._send(
        user, conversation,
        "You can view this and everything else on your account anytime at https://migra.ng/dashboard."
      );
    }

    conversation.context = {
      ...conversation.context,
      pending_tier: null, pending_action: null, pending_purpose: null, pending_checkout_url: null, pending_payment_id: null,
    };
    await conversation.save();

    // Navigate's actual post-payment experience (re-assessment, pathway shortlist, roadmap,
    // Navigate-specific menu) — hasPaidTier short-circuits _requireTier before a second
    // Payment row is ever created for an already-subscribed user, so a "navigate" tier
    // confirmation here always means this is the moment they become a subscriber.
    if (payment.tier === "navigate") {
      await this._startNavigateOnboarding(user, conversation, pendingAction);
      return;
    }
    if (payment.tier === "relocate") {
      await this._startRelocateOnboarding(user, conversation, pendingAction);
      return;
    }

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

  // Business decision 2026-09-28: these automatically-detected triggers (legal questions,
  // visa refusal, immigration violations, document concerns, fraud reports, AI-flagged
  // complaints) used to hard-stop the conversation with a canned "this requires a specialist"
  // and nothing else. Now that AI is actually configured, the bot keeps trying to help
  // instead of immediately punting — staff still get silently flagged for visibility (same
  // _escalate bookkeeping as before), but the user never sees a hand-off message and
  // processing continues normally. This is separate from the *explicit* "Speak to an Expert"/
  // consultation-booking flow and the structural hand-offs (Relocate custom pricing, failed
  // payment links) — those still need an actual human and are untouched.
  async _maybeEscalate(user, conversation, text, extracted) {
    const reason = detectEscalationReason(text, extracted);
    if (!reason) return false;
    if (reason.toLowerCase().includes("suspicious") || reason.toLowerCase().includes("fraud")) {
      // Not a hand-off message — genuinely useful safety info regardless of who/what answers.
      await this._send(user, conversation, FRAUD_WARNING_MESSAGE);
    }
    await this._escalate(conversation, reason);
    return false;
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
    // Native tappable buttons/lists aren't guaranteed to render on every WhatsApp client
    // version for an unofficial (Baileys) connection — see whatsapp/baileysClient.js's own
    // doc comment. When they silently fail to render, a bare lead-in like "Would you like
    // to:" with nothing tappable leaves the user with no visible options at all. Always
    // spelling the choices out as numbered text in the body itself (in addition to, not
    // instead of, the native buttons) means the message is self-sufficient either way.
    const bodyText = options && options.length
      ? text + "\n\n" + options.map((o, i) => `${i + 1}. ${o}`).join("\n")
      : text;

    // Real "typing…" indicator + a length-scaled delay before every bot reply — an
    // always-instant response is itself a strong automation signal (see
    // baileysClient.js's simulateTyping for the full reasoning). Every _send() call is a
    // genuine bot-to-user reply, so this is the one correct choke point — staff messages
    // (admin/service.js's sendStaffMessage) and scheduled bulk sends (scheduler.js) call
    // whatsappClient.sendText directly and are deliberately not routed through here.
    await this.whatsappClient.simulateTyping(user.whatsapp_number, bodyText);

    let result;
    if (options && options.length > 3) {
      result = await this.whatsappClient.sendListOptions(user.whatsapp_number, bodyText, listButtonText || "Choose", options);
    } else if (options && options.length) {
      result = await this.whatsappClient.sendButtonOptions(user.whatsapp_number, bodyText, options);
    } else {
      result = await this.whatsappClient.sendText(user.whatsapp_number, bodyText);
    }

    await Message.create({
      conversation_id: conversation.id,
      direction: "outbound",
      sender: "bot",
      text: bodyText,
      whatsapp_message_id: result?.key?.id ?? null,
    });
  }
}
