// PRD section 30 — Admin Dashboard, shared service layer.
//
// Used by both the JSON API (admin/apiRoutes.js) and the server-rendered dashboard
// (admin/uiRoutes.js) — a form POST from the dashboard calls the exact same function a JSON
// client would hit, so behavior (including audit logging) never drifts between the two.

import { randomUUID } from "node:crypto";
import { Op, literal } from "sequelize";
import { settings } from "../config.js";
import * as analytics from "./analytics.js";
import { logAction } from "./audit.js";
import { HttpError } from "./httpError.js";
import { initializeTransaction } from "../payments/paystackClient.js";
import {
  AdminUser,
  Application,
  AuditLog,
  BlogPost,
  ConsultationBooking,
  ContactMessage,
  Conversation,
  Country,
  Document,
  EligibilityAssessment,
  FAQ,
  Guide,
  Lead,
  Message,
  MigrationProfile,
  NewsPost,
  JobListing,
  Pathway,
  Payment,
  Task,
  TeamMember,
  User,
} from "../db/models.js";
import { hashPassword } from "../security/passwords.js";
import { APPLICATION_STAGE_ORDER } from "../conversation/manager.js";
import { generateChecklist } from "../documents/checklist.js";
import { whatsappClient } from "../whatsapp/baileysClient.js";

// --------------------------------------------------------------------------- //
// Overview / analytics
// --------------------------------------------------------------------------- //

export async function overview() {
  const totalUsers = await User.count();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
  const newUsers = await User.count({ where: { created_at: { [Op.gte]: sevenDaysAgo } } });

  const totalLeads = await Lead.count();
  const hotLeads = await Lead.count({ where: { classification: "HOT" } });
  const warmLeads = await Lead.count({ where: { classification: "WARM" } });
  const convertedLeads = await Lead.count({ where: { status: "converted" } });

  const escalatedConversations = await Conversation.count({ where: { escalation_status: "requested" } });
  const activeConversations = await Conversation.count({ where: { state: { [Op.notIn]: ["ended", "escalated"] } } });
  const totalConversations = await Conversation.count();
  const totalMessages = await Message.count();
  const avgMessagesPerConversation = totalConversations
    ? Math.round((10 * totalMessages) / totalConversations) / 10
    : 0.0;

  const returningRows = await Conversation.findAll({
    attributes: ["user_id"],
    group: ["user_id"],
    having: literal("COUNT(id) > 1"),
  });
  const returningUsers = returningRows.length;

  const qualifiedMigrationJourneys = await EligibilityAssessment.count({ distinct: true, col: "user_id" });

  const pendingDocumentReviews = await Document.count({ where: { verification_status: "unreviewed" } });
  const consultationsRequested = await ConsultationBooking.count({ where: { status: "requested" } });

  const conversionRate = totalLeads ? Math.round((1000 * convertedLeads) / totalLeads) / 10 : 0.0;

  return {
    total_users: totalUsers,
    new_users_7d: newUsers,
    returning_users: returningUsers,
    total_leads: totalLeads,
    hot_leads: hotLeads,
    warm_leads: warmLeads,
    converted_leads: convertedLeads,
    conversion_rate_pct: conversionRate,
    escalated_conversations: escalatedConversations,
    active_conversations: activeConversations,
    avg_messages_per_conversation: avgMessagesPerConversation,
    qualified_migration_journeys: qualifiedMigrationJourneys,
    north_star_note: "Qualified Migration Journeys Initiated (PRD section 35 North Star Metric)",
    pending_document_reviews: pendingDocumentReviews,
    consultations_requested: consultationsRequested,
  };
}

export async function dashboardCharts() {
  const leadTimestamps = (await Lead.findAll({ attributes: ["created_at"] })).map((l) => l.created_at);
  const conversationTimestamps = (await Conversation.findAll({ attributes: ["created_at"] })).map((c) => c.created_at);
  const hotWarmTimestamps = (
    await Lead.findAll({ attributes: ["created_at"], where: { classification: { [Op.in]: ["HOT", "WARM"] } } })
  ).map((l) => l.created_at);
  const consultationTimestamps = (await ConsultationBooking.findAll({ attributes: ["created_at"] })).map(
    (c) => c.created_at
  );

  function stat(timestamps) {
    const s = analytics.statWithTrend(timestamps);
    s.sparkline_points = analytics.sparklineSvgPath(s.sparkline_counts);
    return s;
  }

  const totalLeads = leadTimestamps.length;
  const converted = await Lead.count({ where: { status: "converted" } });
  const conversionStat = {
    count_last_period: totalLeads ? Math.round((1000 * converted) / totalLeads) / 10 : 0.0,
    change_pct: null,
  };

  const trend = await analytics.conversationsTrend(14);
  const leadTrend = analytics.bucketByDay(leadTimestamps, 14);
  const maxTrend = Math.max(0, ...trend.map((t) => t.count), ...leadTrend.map((t) => t.count)) || 1;
  const trendPoints = analytics.sparklineSvgPath(trend.map((t) => t.count), 680, 180);
  const trendAreaPoints = trendPoints ? `0,180 ${trendPoints} 680,180` : "";
  const leadTrendPoints = analytics.sparklineSvgPath(leadTrend.map((t) => t.count), 680, 180);

  return {
    stats: {
      total_leads: stat(leadTimestamps),
      active_conversations: stat(conversationTimestamps),
      qualified_leads: stat(hotWarmTimestamps),
      consultations: stat(consultationTimestamps),
      conversion_rate: conversionStat,
    },
    conversations_trend: trend,
    conversations_trend_max: maxTrend,
    conversations_trend_points: trendPoints,
    conversations_trend_area_points: trendAreaPoints,
    leads_trend_points: leadTrendPoints,
    funnel: await analytics.leadsFunnel(),
    leads_by_classification: await analytics.leadsByClassification(),
    top_pathways: await analytics.topMigrationPathways(),
  };
}

/** Most recently created leads, newest first — for the dashboard's activity feed. */
export async function recentLeads(limit = 5) {
  const leads = await Lead.findAll({
    order: [["created_at", "DESC"]],
    limit,
    include: [{ association: "user" }],
  });
  return leads.map((lead) => ({
    id: lead.id,
    name: lead.user.name,
    whatsapp_number: lead.user.whatsapp_number,
    classification: lead.classification,
    status: lead.status,
    created_at: lead.created_at.toISOString(),
  }));
}

/** Real counts for the dashboard's task-overview panel — pending, due today, overdue, and
 * completed (all-time). "Overdue" excludes anything already completed. */
export async function taskStats() {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);

  const pending = await Task.count({ where: { status: { [Op.ne]: "completed" } } });
  const dueToday = await Task.count({
    where: { status: { [Op.ne]: "completed" }, due_at: { [Op.between]: [todayStart, todayEnd] } },
  });
  const overdue = await Task.count({
    where: { status: { [Op.ne]: "completed" }, due_at: { [Op.lt]: todayStart } },
  });
  const completed = await Task.count({ where: { status: "completed" } });

  return { pending, due_today: dueToday, overdue, completed };
}

// --------------------------------------------------------------------------- //
// Leads
// --------------------------------------------------------------------------- //

export async function listLeads(classification = null) {
  const where = classification ? { classification: classification.toUpperCase() } : {};
  const leads = await Lead.findAll({
    where,
    order: [["score", "DESC"]],
    include: [{ association: "user", include: [{ association: "profile" }] }],
  });
  return leads.map((lead) => ({
    id: lead.id,
    user_id: lead.user_id,
    whatsapp_number: lead.user.whatsapp_number,
    name: lead.user.name,
    email: lead.user.email,
    location: lead.user.location,
    score: lead.score,
    classification: lead.classification,
    status: lead.status,
    assigned_agent: lead.assigned_agent,
    reasons: lead.reasons,
    destination_country: lead.user.profile?.destination_country ?? null,
    migration_objective: lead.user.profile?.migration_objective ?? null,
    created_at: lead.created_at.toISOString(),
  }));
}

export async function updateLead(leadId, { status, assigned_agent } = {}, actor) {
  const lead = await Lead.findByPk(leadId);
  if (!lead) throw new HttpError(404, "Lead not found");
  const details = {};
  if (status != null) {
    lead.status = status;
    details.status = status;
  }
  if (assigned_agent != null) {
    lead.assigned_agent = assigned_agent;
    details.assigned_agent = assigned_agent;
  }
  await lead.save();
  await logAction({ actor, action: "update_lead", targetType: "lead", targetId: leadId, details });
  return { id: lead.id, status: lead.status, assigned_agent: lead.assigned_agent };
}

// --------------------------------------------------------------------------- //
// Conversations
// --------------------------------------------------------------------------- //

export async function listConversations(escalatedOnly = false) {
  const where = escalatedOnly ? { escalation_status: "requested" } : {};
  const conversations = await Conversation.findAll({
    where,
    order: [["updated_at", "DESC"]],
    include: [{ association: "user" }],
  });
  return conversations.map((c) => ({
    id: c.id,
    whatsapp_number: c.user.whatsapp_number,
    name: c.user.name,
    state: c.state,
    escalation_status: c.escalation_status,
    escalation_reason: c.escalation_reason,
    updated_at: c.updated_at.toISOString(),
  }));
}

export async function getConversation(conversationId) {
  const conversation = await Conversation.findByPk(conversationId, { include: [{ association: "user" }] });
  if (!conversation) throw new HttpError(404, "Conversation not found");
  const messages = await Message.findAll({
    where: { conversation_id: conversationId },
    order: [["created_at", "ASC"]],
  });

  // FR-11 "conversation context transferred to the human agent so the user does not have
  // to repeat their information" — a structured summary, not just the raw transcript, so
  // staff taking over don't have to scroll and reconstruct the profile by hand.
  const profile = await MigrationProfile.findOne({ where: { user_id: conversation.user_id } });
  const lead = await Lead.findOne({ where: { user_id: conversation.user_id }, order: [["created_at", "DESC"]] });
  const latestAssessment = await EligibilityAssessment.findOne({
    where: { user_id: conversation.user_id },
    order: [["created_at", "DESC"]],
  });

  return {
    id: conversation.id,
    whatsapp_number: conversation.user.whatsapp_number,
    name: conversation.user.name,
    email: conversation.user.email,
    location: conversation.user.location,
    state: conversation.state,
    escalation_status: conversation.escalation_status,
    escalation_reason: conversation.escalation_reason,
    profile: profile
      ? {
          destination_country: profile.destination_country,
          migration_objective: profile.migration_objective,
          age: profile.age,
          education: profile.education,
          occupation: profile.occupation,
          experience_years: profile.experience_years,
          language_ability: profile.language_ability,
          family_status: profile.family_status,
          timeline: profile.timeline,
          financial_readiness: profile.financial_readiness,
          job_offer_status: profile.job_offer_status,
          professional_registration: profile.professional_registration,
        }
      : null,
    lead: lead ? { score: lead.score, classification: lead.classification, status: lead.status } : null,
    latest_assessment_result: latestAssessment ? latestAssessment.result : null,
    messages: messages.map((m) => ({
      direction: m.direction,
      sender: m.sender,
      text: m.text,
      delivery_status: m.delivery_status,
      delivery_error: m.delivery_error,
      created_at: m.created_at.toISOString(),
    })),
  };
}

export async function resolveConversation(conversationId, resolvedBy, actor) {
  const conversation = await Conversation.findByPk(conversationId);
  if (!conversation) throw new HttpError(404, "Conversation not found");
  conversation.escalation_status = "in_progress";
  await conversation.save();
  await logAction({
    actor,
    action: "resolve_conversation",
    targetType: "conversation",
    targetId: conversationId,
    details: { resolved_by: resolvedBy },
  });
  return { id: conversation.id, escalation_status: conversation.escalation_status, resolved_by: resolvedBy };
}

/** A staff member typing a real reply, delivered over the same WhatsApp connection the bot
 * uses. Marks the conversation `in_progress` (if it isn't already) so the bot's own
 * handleInbound stays quiet and doesn't talk over the human — see
 * conversation/manager.js's escalation_status check. */
export async function sendStaffMessage(conversationId, text, actor) {
  const body = (text || "").trim();
  if (!body) throw new HttpError(400, "Message text is required");

  const conversation = await Conversation.findByPk(conversationId, { include: [{ association: "user" }] });
  if (!conversation) throw new HttpError(404, "Conversation not found");

  const result = await whatsappClient.sendText(conversation.user.whatsapp_number, body);

  await Message.create({
    conversation_id: conversation.id,
    direction: "outbound",
    sender: "human_agent",
    text: body,
    whatsapp_message_id: result?.key?.id ?? null,
  });

  if (conversation.escalation_status !== "in_progress") {
    conversation.escalation_status = "in_progress";
    if (!conversation.escalation_reason) conversation.escalation_reason = `Staff reply from ${actor}`;
  }
  await conversation.save();

  await logAction({
    actor,
    action: "send_staff_message",
    targetType: "conversation",
    targetId: conversationId,
    details: { length: body.length },
  });

  return { id: conversation.id, escalation_status: conversation.escalation_status };
}

/** Hands the conversation back to full bot control after a staff takeover. The bot only
 * ever goes quiet while escalation_status is "in_progress" (see conversation/manager.js) —
 * a bare "requested" flag never silences it — so this mainly matters after resolveConversation/
 * sendStaffMessage put a conversation in "in_progress". Also resets fallback_count as a clean
 * slate for the returning conversation (fallback_count no longer drives escalation on its own —
 * see escalation.js — but it's still tracked per-menu-state for "pick an option" reprompts). */
export async function returnConversationToBot(conversationId, actor) {
  const conversation = await Conversation.findByPk(conversationId);
  if (!conversation) throw new HttpError(404, "Conversation not found");
  conversation.escalation_status = "resolved";
  conversation.fallback_count = 0;
  await conversation.save();
  await logAction({ actor, action: "return_conversation_to_bot", targetType: "conversation", targetId: conversationId });
  return { id: conversation.id, escalation_status: conversation.escalation_status };
}

// --------------------------------------------------------------------------- //
// Documents (FR-08) — staff review
// --------------------------------------------------------------------------- //

export async function listDocuments(status = null) {
  const where = status ? { verification_status: status } : {};
  const documents = await Document.findAll({ where, order: [["uploaded_at", "DESC"]], include: [{ association: "user" }] });
  return documents.map((d) => ({
    id: d.id,
    user_id: d.user_id,
    whatsapp_number: d.user.whatsapp_number,
    document_type: d.document_type,
    original_filename: d.original_filename,
    status: d.status,
    verification_status: d.verification_status,
    verified_by: d.verified_by,
    uploaded_at: d.uploaded_at ? d.uploaded_at.toISOString() : null,
  }));
}

export async function reviewDocument(documentId, verificationStatus, actor) {
  if (!["verified", "rejected"].includes(verificationStatus)) {
    throw new HttpError(400, "verification_status must be 'verified' or 'rejected'");
  }
  const document = await Document.findByPk(documentId);
  if (!document) throw new HttpError(404, "Document not found");
  document.verification_status = verificationStatus;
  document.verified_by = actor;
  document.status = verificationStatus === "verified" ? "verified" : "rejected";
  await document.save();
  await logAction({
    actor,
    action: "review_document",
    targetType: "document",
    targetId: documentId,
    details: { verification_status: verificationStatus },
  });
  await maybeAdvanceApplicationAfterDocumentReview(document.user_id);
  return { id: document.id, verification_status: document.verification_status, status: document.status };
}

async function maybeAdvanceApplicationAfterDocumentReview(userId) {
  const application = await Application.findOne({ where: { user_id: userId }, order: [["created_at", "DESC"]] });
  if (!application || !application.pathway_id) return;
  const pathway = await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] });
  if (!pathway) return;
  const documents = await Document.findAll({ where: { user_id: userId } });
  const checklist = generateChecklist(pathway, documents);
  const allVerified =
    checklist.items.length > 0 &&
    checklist.items.every((item) => {
      const doc = documents.find((d) => d.document_type === item.name);
      return doc?.verification_status === "verified";
    });
  if (
    allVerified &&
    APPLICATION_STAGE_ORDER.indexOf(application.stage) < APPLICATION_STAGE_ORDER.indexOf("application_preparation")
  ) {
    application.stage = "application_preparation";
    await application.save();
    // FR-13 application milestone notification — this stage change happens asynchronously
    // (triggered by staff reviewing documents, not by anything the user just said), so unlike
    // other stage transitions there's no accompanying reply already telling the user.
    const user = await User.findByPk(userId);
    if (user) {
      await whatsappClient.sendText(
        user.whatsapp_number,
        `Milestone update: all your required documents for ${pathway.country.name} ${pathway.name} ` +
          "are verified, and your application has moved to Application Preparation. " +
          "A MigraTech specialist will be in touch on next steps."
      );
    }
  }
}

// --------------------------------------------------------------------------- //
// Consultations (FR-12)
// --------------------------------------------------------------------------- //

export async function listConsultations(status = null) {
  const where = status ? { status } : {};
  const bookings = await ConsultationBooking.findAll({
    where,
    order: [["created_at", "DESC"]],
    include: [{ association: "user" }],
  });
  return bookings.map((b) => ({
    id: b.id,
    user_id: b.user_id,
    whatsapp_number: b.user.whatsapp_number,
    preferred_time_text: b.preferred_time_text,
    contact_email: b.contact_email,
    status: b.status,
    created_at: b.created_at.toISOString(),
  }));
}

export async function updateConsultation(bookingId, status, actor) {
  const booking = await ConsultationBooking.findByPk(bookingId);
  if (!booking) throw new HttpError(404, "Consultation booking not found");
  booking.status = status;
  await booking.save();
  await logAction({
    actor,
    action: "update_consultation",
    targetType: "consultation_booking",
    targetId: bookingId,
    details: { status },
  });
  return { id: booking.id, status: booking.status };
}

// --------------------------------------------------------------------------- //
// Knowledge base management — admin role only for writes
// --------------------------------------------------------------------------- //

export async function listCountries() {
  const countries = await Country.findAll();
  return countries.map((c) => ({ id: c.id, name: c.name, code: c.code }));
}

export async function createCountry(payload, actor) {
  const country = await Country.create(payload);
  await logAction({ actor, action: "create_country", targetType: "country", targetId: country.id, details: { name: country.name } });
  return { id: country.id, name: country.name };
}

export async function updateCountry(countryId, payload, actor) {
  const country = await Country.findByPk(countryId);
  if (!country) throw new HttpError(404, "Country not found");
  Object.assign(country, payload);
  await country.save();
  await logAction({ actor, action: "update_country", targetType: "country", targetId: countryId });
  return { id: country.id, name: country.name };
}

export async function listPathways() {
  const pathways = await Pathway.findAll({ include: [{ model: Country, as: "country" }] });
  return pathways.map((p) => ({
    id: p.id,
    country_id: p.country_id,
    country: p.country.name,
    name: p.name,
    category: p.category,
    summary: p.summary,
    documents: p.documents,
    requirements: p.requirements,
    is_verified_content: p.is_verified_content,
    last_verified_at: p.last_verified_at ? p.last_verified_at.toISOString() : null,
    source_url: p.source_url,
    version: p.version,
  }));
}

/** FR-13 "new relevant migration opportunities" / "changes to relevant pathway information"
 * — notifies users whose saved profile (destination + goal) matches this pathway. Only
 * fires for verified content: unverified/draft pathway data shouldn't be pushed to users as
 * a real opportunity (same principle guardrails.js enforces for AI answers). */
async function notifyMatchingUsersOfPathway(pathway, changeType) {
  if (!pathway.is_verified_content) return;
  const country = await Country.findByPk(pathway.country_id);
  if (!country) return;

  const profiles = await MigrationProfile.findAll({
    where: { destination_country: country.name, migration_objective: pathway.category },
    include: [{ association: "user" }],
  });

  const verb = changeType === "created" ? "A new" : "An updated";
  for (const profile of profiles) {
    if (!profile.user) continue;
    await whatsappClient.sendText(
      profile.user.whatsapp_number,
      `${verb} migration pathway may be relevant to you: ${country.name} — ${pathway.name}. ` +
        'Reply "menu" to explore it, or ask us anything about it.'
    );
  }
}

export async function createPathway(payload, actor) {
  const data = { ...payload };
  if (data.is_verified_content) data.last_verified_at = new Date();
  const pathway = await Pathway.create(data);
  await logAction({ actor, action: "create_pathway", targetType: "pathway", targetId: pathway.id, details: { name: pathway.name } });
  await notifyMatchingUsersOfPathway(pathway, "created");
  return { id: pathway.id, name: pathway.name };
}

export async function updatePathway(pathwayId, payload, actor) {
  const pathway = await Pathway.findByPk(pathwayId);
  if (!pathway) throw new HttpError(404, "Pathway not found");
  const wasVerified = pathway.is_verified_content;
  Object.assign(pathway, payload);
  if (payload.is_verified_content && !wasVerified) pathway.last_verified_at = new Date();
  await pathway.save();
  await logAction({ actor, action: "update_pathway", targetType: "pathway", targetId: pathwayId });
  await notifyMatchingUsersOfPathway(pathway, "updated");
  return { id: pathway.id, name: pathway.name };
}

export async function deletePathway(pathwayId, actor) {
  const pathway = await Pathway.findByPk(pathwayId);
  if (!pathway) throw new HttpError(404, "Pathway not found");
  await pathway.destroy();
  await logAction({ actor, action: "delete_pathway", targetType: "pathway", targetId: pathwayId });
  return { deleted: pathwayId };
}

export async function listFaqs() {
  const faqs = await FAQ.findAll();
  return faqs.map((f) => ({
    id: f.id,
    question: f.question,
    answer: f.answer,
    category: f.category,
    source_url: f.source_url,
    is_verified_content: f.is_verified_content,
  }));
}

export async function createFaq(payload, actor) {
  const data = { ...payload };
  if (data.is_verified_content) data.last_verified_at = new Date();
  const faq = await FAQ.create(data);
  await logAction({ actor, action: "create_faq", targetType: "faq", targetId: faq.id, details: { question: faq.question } });
  return { id: faq.id, question: faq.question };
}

export async function updateFaq(faqId, payload, actor) {
  const faq = await FAQ.findByPk(faqId);
  if (!faq) throw new HttpError(404, "FAQ not found");
  const wasVerified = faq.is_verified_content;
  Object.assign(faq, payload);
  if (payload.is_verified_content && !wasVerified) faq.last_verified_at = new Date();
  await faq.save();
  await logAction({ actor, action: "update_faq", targetType: "faq", targetId: faqId });
  return { id: faq.id, question: faq.question };
}

export async function deleteFaq(faqId, actor) {
  const faq = await FAQ.findByPk(faqId);
  if (!faq) throw new HttpError(404, "FAQ not found");
  await faq.destroy();
  await logAction({ actor, action: "delete_faq", targetType: "faq", targetId: faqId });
  return { deleted: faqId };
}

// --------------------------------------------------------------------------- //
// Staff accounts (admin role only) + audit log
// --------------------------------------------------------------------------- //

export async function listStaff() {
  const users = await AdminUser.findAll();
  return users.map((u) => ({ id: u.id, username: u.username, role: u.role, is_active: u.is_active }));
}

export async function createStaff({ username, password, role = "agent" }, actor) {
  if (!["admin", "agent"].includes(role)) throw new HttpError(400, "role must be 'admin' or 'agent'");
  if (await AdminUser.findOne({ where: { username } })) throw new HttpError(409, "Username already exists");
  const staff = await AdminUser.create({ username, password_hash: hashPassword(password), role });
  await logAction({ actor, action: "create_staff", targetType: "admin_user", targetId: staff.id, details: { role: staff.role } });
  return { id: staff.id, username: staff.username, role: staff.role };
}

export async function listAuditLog(limit = 200) {
  const entries = await AuditLog.findAll({ order: [["created_at", "DESC"]], limit });
  return entries.map((e) => ({
    id: e.id,
    actor: e.actor,
    action: e.action,
    target_type: e.target_type,
    target_id: e.target_id,
    details: e.details,
    created_at: e.created_at.toISOString(),
  }));
}

// --------------------------------------------------------------------------- //
// User data deletion (PRD section 36)
// --------------------------------------------------------------------------- //

export async function deleteUser(userId, actor) {
  const user = await User.findByPk(userId);
  if (!user) throw new HttpError(404, "User not found");
  await logAction({ actor, action: "delete_user", targetType: "user", targetId: userId, details: { whatsapp_number: user.whatsapp_number } });
  await user.destroy();
  return { deleted: userId };
}

// --------------------------------------------------------------------------- //
// Users (every WhatsApp contact, regardless of lead status)
// --------------------------------------------------------------------------- //

export async function listUsers() {
  const users = await User.findAll({ order: [["created_at", "DESC"]], include: [{ association: "profile" }] });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    whatsapp_number: u.whatsapp_number,
    email: u.email,
    location: u.location,
    consent_given: u.consent_given,
    destination_country: u.profile?.destination_country ?? null,
    migration_objective: u.profile?.migration_objective ?? null,
    created_at: u.created_at.toISOString(),
  }));
}

/** Real substring search across users by name, WhatsApp number, or email — used by the
 * admin topbar search box. Empty/short queries return no results rather than the whole table. */
export async function searchUsers(query) {
  const q = (query || "").trim();
  if (q.length < 2) return [];
  const users = await User.findAll({
    where: {
      [Op.or]: [
        { name: { [Op.like]: `%${q}%` } },
        { whatsapp_number: { [Op.like]: `%${q}%` } },
        { email: { [Op.like]: `%${q}%` } },
      ],
    },
    order: [["created_at", "DESC"]],
    limit: 25,
    include: [{ association: "profile" }],
  });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    whatsapp_number: u.whatsapp_number,
    email: u.email,
    destination_country: u.profile?.destination_country ?? null,
  }));
}

// --------------------------------------------------------------------------- //
// Applications (FR-14)
// --------------------------------------------------------------------------- //

export async function listApplications() {
  const applications = await Application.findAll({
    order: [["updated_at", "DESC"]],
    include: [
      { association: "user" },
      { association: "pathway", include: [{ model: Country, as: "country" }] },
    ],
  });
  return applications.map((a) => ({
    id: a.id,
    whatsapp_number: a.user.whatsapp_number,
    name: a.user.name,
    pathway: a.pathway ? `${a.pathway.country.name} — ${a.pathway.name}` : "—",
    stage: a.stage,
    status: a.status,
    assigned_specialist: a.assigned_specialist,
    updated_at: a.updated_at.toISOString(),
  }));
}

// --------------------------------------------------------------------------- //
// Tasks (staff to-dos, optionally linked to a lead)
// --------------------------------------------------------------------------- //

export async function listTasks(status = null) {
  const where = status ? { status } : {};
  const tasks = await Task.findAll({
    where,
    order: [["created_at", "DESC"]],
    include: [{ association: "lead", include: [{ association: "user" }] }],
  });
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    assigned_agent: t.assigned_agent,
    lead_id: t.lead_id,
    lead_whatsapp_number: t.lead?.user?.whatsapp_number ?? null,
    due_at: t.due_at ? t.due_at.toISOString() : null,
    created_by: t.created_by,
    created_at: t.created_at.toISOString(),
    completed_at: t.completed_at ? t.completed_at.toISOString() : null,
  }));
}

export async function createTask(payload, actor) {
  if (!["low", "medium", "high"].includes(payload.priority || "medium")) {
    throw new HttpError(400, "priority must be low, medium, or high");
  }
  const task = await Task.create({ ...payload, created_by: actor });
  await logAction({ actor, action: "create_task", targetType: "task", targetId: task.id, details: { title: task.title } });
  return { id: task.id, title: task.title };
}

export async function updateTask(taskId, status, actor) {
  if (!["pending", "in_progress", "completed"].includes(status)) {
    throw new HttpError(400, "status must be pending, in_progress, or completed");
  }
  const task = await Task.findByPk(taskId);
  if (!task) throw new HttpError(404, "Task not found");
  task.status = status;
  task.completed_at = status === "completed" ? new Date() : null;
  await task.save();
  await logAction({ actor, action: "update_task", targetType: "task", targetId: taskId, details: { status } });
  return { id: task.id, status: task.status };
}

// --------------------------------------------------------------------------- //
// Payments — internal fee record-keeping only. This is a staff-maintained ledger,
// not a payment processor integration: no card/bank details are ever collected,
// stored, or transmitted here. `method`/`reference` are free-text notes staff enter
// for their own reconciliation (e.g. "Bank transfer", "REF-20260820-01").
// --------------------------------------------------------------------------- //

const PAYMENT_STATUSES = ["pending", "paid", "waived", "refunded"];

export async function listPayments(status = null) {
  const where = status ? { status } : {};
  const payments = await Payment.findAll({
    where,
    order: [["created_at", "DESC"]],
    include: [{ association: "user" }, { association: "lead" }],
  });
  return payments.map((p) => ({
    id: p.id,
    user_id: p.user_id,
    whatsapp_number: p.user.whatsapp_number,
    name: p.user.name,
    lead_id: p.lead_id,
    amount: Number(p.amount),
    currency: p.currency,
    purpose: p.purpose,
    status: p.status,
    tier: p.tier,
    provider: p.provider,
    method: p.method,
    reference: p.reference,
    notes: p.notes,
    recorded_by: p.recorded_by,
    paid_at: p.paid_at ? p.paid_at.toISOString() : null,
    created_at: p.created_at.toISOString(),
  }));
}

/** Real, computed from the ledger — never a fabricated revenue figure. `collected` only
 * counts rows actually marked `paid`. */
export async function paymentStats() {
  const rows = await Payment.findAll({ attributes: ["amount", "status"] });
  let collected = 0;
  let pending = 0;
  for (const r of rows) {
    const amt = Number(r.amount);
    if (r.status === "paid") collected += amt;
    else if (r.status === "pending") pending += amt;
  }
  return {
    collected: Math.round(collected * 100) / 100,
    pending: Math.round(pending * 100) / 100,
    pending_count: rows.filter((r) => r.status === "pending").length,
  };
}

const PAYMENT_TIERS = ["navigate", "relocate"];

export async function createPayment(payload, actor) {
  if (!payload.user_id) throw new HttpError(400, "user_id is required");
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, "amount must be a positive number");
  if (!payload.purpose) throw new HttpError(400, "purpose is required");

  const tier = PAYMENT_TIERS.includes(payload.tier) ? payload.tier : null;

  // "Generate & send Paystack link" — mainly for RELOCATE, whose price varies by pathway/
  // service (product spec) so the bot never auto-prices it; staff issue a custom-amount
  // link here instead of marking a manual ledger entry paid after an offline transfer.
  if (payload.send_paystack_link) {
    if (!settings.paystackConfigured) throw new HttpError(400, "Paystack isn't configured (PAYSTACK_SECRET_KEY is not set)");
    const user = await User.findByPk(payload.user_id);
    if (!user) throw new HttpError(404, "User not found");

    const email = payload.payer_email || user.email;
    if (!email) throw new HttpError(400, "This client has no email on file — provide a payer email to generate a Paystack link");
    if (email !== user.email) {
      user.email = email;
      await user.save();
    }

    const reference = `${tier || "custom"}-${randomUUID()}`;
    const payment = await Payment.create({
      user_id: payload.user_id,
      lead_id: payload.lead_id || null,
      amount,
      currency: payload.currency || "NGN",
      purpose: payload.purpose,
      status: "pending",
      tier,
      provider: "paystack",
      reference,
      notes: payload.notes || null,
      recorded_by: actor,
    });

    const { authorization_url } = await initializeTransaction({
      email,
      amountNaira: amount,
      reference,
      metadata: { user_id: payload.user_id, tier },
    });
    await whatsappClient.sendText(
      user.whatsapp_number,
      `MigraTech: here's your payment link for "${payload.purpose}" (${payment.currency} ` +
        `${amount.toLocaleString()}):\n${authorization_url}\n\nI'll confirm automatically once it's paid.`
    );

    await logAction({
      actor,
      action: "create_payment",
      targetType: "payment",
      targetId: payment.id,
      details: { amount, currency: payment.currency, purpose: payment.purpose, status: "pending", provider: "paystack", tier },
    });
    return { id: payment.id, status: payment.status, checkout_url: authorization_url };
  }

  const status = payload.status && PAYMENT_STATUSES.includes(payload.status) ? payload.status : "pending";
  const payment = await Payment.create({
    user_id: payload.user_id,
    lead_id: payload.lead_id || null,
    amount,
    currency: payload.currency || "NGN",
    purpose: payload.purpose,
    status,
    tier,
    provider: "manual",
    method: payload.method || null,
    reference: payload.reference || null,
    notes: payload.notes || null,
    recorded_by: actor,
    paid_at: status === "paid" ? new Date() : null,
  });
  await logAction({
    actor,
    action: "create_payment",
    targetType: "payment",
    targetId: payment.id,
    details: { amount, currency: payment.currency, purpose: payment.purpose, status },
  });
  return { id: payment.id, status: payment.status };
}

export async function updatePayment(paymentId, status, actor) {
  if (!PAYMENT_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of: ${PAYMENT_STATUSES.join(", ")}`);
  }
  const payment = await Payment.findByPk(paymentId);
  if (!payment) throw new HttpError(404, "Payment not found");
  payment.status = status;
  payment.paid_at = status === "paid" ? new Date() : payment.paid_at;
  await payment.save();
  await logAction({ actor, action: "update_payment", targetType: "payment", targetId: paymentId, details: { status } });
  return { id: payment.id, status: payment.status };
}

// --------------------------------------------------------------------------- //
// Public site content (Blog / News / Guides) — admin-managed, staff-authored pages
// rendered at /blog, /news, /guides. Three separate tables (see db/models.js) but
// identical shape today, so the actual CRUD mechanics are shared internally — the
// exported functions per type are what keeps Blog/News/Guides genuinely independent from
// an admin-routing and future-schema-divergence standpoint.
// --------------------------------------------------------------------------- //

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
}

async function uniqueSlug(Model, base, excludeId = null) {
  const root = slugify(base) || "post";
  let slug = root;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const where = excludeId ? { slug, id: { [Op.ne]: excludeId } } : { slug };
    if (!(await Model.findOne({ where }))) return slug;
    slug = `${root}-${n++}`;
  }
}

function serializeContentSummary(item) {
  return {
    id: item.id,
    title: item.title,
    slug: item.slug,
    excerpt: item.excerpt,
    author: item.author,
    is_published: item.is_published,
    published_at: item.published_at ? item.published_at.toISOString() : null,
    created_at: item.created_at.toISOString(),
  };
}

async function listContentItems(Model) {
  const items = await Model.findAll({ order: [["created_at", "DESC"]] });
  return items.map(serializeContentSummary);
}

async function createContentItem(Model, targetType, payload, actor) {
  const title = (payload.title || "").trim();
  const body = (payload.body || "").trim();
  if (!title) throw new HttpError(400, "Title is required.");
  if (!body) throw new HttpError(400, "Body is required.");

  const slug = await uniqueSlug(Model, payload.slug || title);
  const isPublished = payload.is_published === "on" || payload.is_published === true;
  const item = await Model.create({
    title,
    slug,
    excerpt: payload.excerpt || null,
    body,
    cover_image_url: payload.cover_image_url || null,
    author: payload.author || actor,
    is_published: isPublished,
    published_at: isPublished ? new Date() : null,
  });
  await logAction({ actor, action: `create_${targetType}`, targetType, targetId: item.id, details: { title } });
  return { id: item.id, slug: item.slug };
}

async function updateContentItem(Model, targetType, id, payload, actor) {
  const item = await Model.findByPk(id);
  if (!item) throw new HttpError(404, "Not found");

  const title = (payload.title || "").trim();
  const body = (payload.body || "").trim();
  if (!title) throw new HttpError(400, "Title is required.");
  if (!body) throw new HttpError(400, "Body is required.");

  const wasPublished = item.is_published;
  const isPublished = payload.is_published === "on" || payload.is_published === true;

  item.title = title;
  if (payload.slug && slugify(payload.slug) !== item.slug) {
    item.slug = await uniqueSlug(Model, payload.slug, item.id);
  }
  item.excerpt = payload.excerpt || null;
  item.body = body;
  item.cover_image_url = payload.cover_image_url || null;
  item.author = payload.author || item.author;
  item.is_published = isPublished;
  if (isPublished && !wasPublished) item.published_at = new Date();
  if (!isPublished) item.published_at = null;
  await item.save();

  await logAction({ actor, action: `update_${targetType}`, targetType, targetId: id, details: { title } });
  return { id: item.id, slug: item.slug };
}

async function deleteContentItem(Model, targetType, id, actor) {
  const item = await Model.findByPk(id);
  if (!item) throw new HttpError(404, "Not found");
  await item.destroy();
  await logAction({ actor, action: `delete_${targetType}`, targetType, targetId: id });
  return { deleted: id };
}

// ---- Blog ----
export async function listBlogPosts() {
  return listContentItems(BlogPost);
}
export async function createBlogPost(payload, actor) {
  return createContentItem(BlogPost, "blog_post", payload, actor);
}
export async function updateBlogPost(id, payload, actor) {
  return updateContentItem(BlogPost, "blog_post", id, payload, actor);
}
export async function deleteBlogPost(id, actor) {
  return deleteContentItem(BlogPost, "blog_post", id, actor);
}

// ---- News ----
export async function listNewsPosts() {
  return listContentItems(NewsPost);
}
export async function createNewsPost(payload, actor) {
  return createContentItem(NewsPost, "news_post", payload, actor);
}
export async function updateNewsPost(id, payload, actor) {
  return updateContentItem(NewsPost, "news_post", id, payload, actor);
}
export async function deleteNewsPost(id, actor) {
  return deleteContentItem(NewsPost, "news_post", id, actor);
}

// ---- Guides ----
export async function listGuides() {
  return listContentItems(Guide);
}
export async function createGuide(payload, actor) {
  return createContentItem(Guide, "guide", payload, actor);
}
export async function updateGuide(id, payload, actor) {
  return updateContentItem(Guide, "guide", id, payload, actor);
}
export async function deleteGuide(id, actor) {
  return deleteContentItem(Guide, "guide", id, actor);
}

// --------------------------------------------------------------------------- //
// Contact messages (portal/service.js's submitContactMessage) — the /contact page's
// "message our team" option, alongside WhatsApp.
// --------------------------------------------------------------------------- //

export async function listContactMessages(status = null) {
  const where = status ? { status } : {};
  const messages = await ContactMessage.findAll({ where, order: [["created_at", "DESC"]] });
  return messages.map((m) => ({
    id: m.id,
    user_id: m.user_id,
    name: m.name,
    email: m.email,
    whatsapp_number: m.whatsapp_number,
    message: m.message,
    status: m.status,
    created_at: m.created_at.toISOString(),
  }));
}

export async function updateContactMessageStatus(id, status, actor) {
  if (!["new", "read", "replied"].includes(status)) {
    throw new HttpError(400, "status must be new, read, or replied");
  }
  const message = await ContactMessage.findByPk(id);
  if (!message) throw new HttpError(404, "Message not found");
  message.status = status;
  await message.save();
  await logAction({ actor, action: "update_contact_message", targetType: "contact_message", targetId: id, details: { status } });
  return { id: message.id, status: message.status };
}

/** Closes the loop on a contact-form message over the same WhatsApp connection the bot
 * uses — only possible when the message has a whatsapp_number on it (only true for messages
 * from a logged-in portal user; anonymous senders only leave an email, see
 * portal/service.js's submitContactMessage). Marks the message replied on send. */
export async function replyToContactMessage(id, replyText, actor) {
  const text = (replyText || "").trim();
  if (!text) throw new HttpError(400, "Reply text is required.");

  const message = await ContactMessage.findByPk(id);
  if (!message) throw new HttpError(404, "Message not found");
  if (!message.whatsapp_number) {
    throw new HttpError(400, "This message has no WhatsApp number on file — reply by email instead.");
  }

  // sendText() can throw (not just return {skipped:true}) if the socket exists but is
  // mid-disconnect — see portal/otp.js for where this was first found.
  let result;
  try {
    result = await whatsappClient.sendText(
      message.whatsapp_number,
      `Hi ${message.name}, this is MigraTech following up on your message:\n\n"${message.message}"\n\n${text}`
    );
  } catch {
    result = { skipped: true };
  }
  if (result?.skipped) {
    throw new HttpError(503, "Couldn't send — WhatsApp isn't connected right now. Check /admin/whatsapp.");
  }

  message.status = "replied";
  await message.save();
  await logAction({ actor, action: "reply_contact_message", targetType: "contact_message", targetId: id });
  return { id: message.id, status: message.status };
}

// --------------------------------------------------------------------------- //
// Team & Careers — real admin-managed pages, deliberately shipped with zero seeded rows
// (no placeholder people or jobs) — /team and /careers show a genuine empty state until
// staff add real entries here.
// --------------------------------------------------------------------------- //

export async function listTeamMembers() {
  const members = await TeamMember.findAll({ order: [["display_order", "ASC"], ["created_at", "ASC"]] });
  return members.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    bio: m.bio,
    photo_url: m.photo_url,
    display_order: m.display_order,
    is_active: m.is_active,
  }));
}

export async function createTeamMember(payload, actor) {
  const name = (payload.name || "").trim();
  if (!name) throw new HttpError(400, "Name is required.");
  const member = await TeamMember.create({
    name,
    role: payload.role || null,
    bio: payload.bio || null,
    photo_url: payload.photo_url || null,
    display_order: Number(payload.display_order) || 0,
    is_active: payload.is_active === "on" || payload.is_active === true,
  });
  await logAction({ actor, action: "create_team_member", targetType: "team_member", targetId: member.id, details: { name } });
  return { id: member.id };
}

export async function updateTeamMember(id, payload, actor) {
  const member = await TeamMember.findByPk(id);
  if (!member) throw new HttpError(404, "Team member not found");
  const name = (payload.name || "").trim();
  if (!name) throw new HttpError(400, "Name is required.");
  member.name = name;
  member.role = payload.role || null;
  member.bio = payload.bio || null;
  member.photo_url = payload.photo_url || null;
  member.display_order = Number(payload.display_order) || 0;
  member.is_active = payload.is_active === "on" || payload.is_active === true;
  await member.save();
  await logAction({ actor, action: "update_team_member", targetType: "team_member", targetId: id });
  return { id: member.id };
}

export async function deleteTeamMember(id, actor) {
  const member = await TeamMember.findByPk(id);
  if (!member) throw new HttpError(404, "Team member not found");
  await member.destroy();
  await logAction({ actor, action: "delete_team_member", targetType: "team_member", targetId: id });
  return { deleted: id };
}

export async function listJobListings() {
  const jobs = await JobListing.findAll({ order: [["created_at", "DESC"]] });
  return jobs.map((j) => ({
    id: j.id,
    title: j.title,
    department: j.department,
    location: j.location,
    employment_type: j.employment_type,
    description: j.description,
    apply_email: j.apply_email,
    apply_url: j.apply_url,
    is_active: j.is_active,
  }));
}

export async function createJobListing(payload, actor) {
  const title = (payload.title || "").trim();
  const description = (payload.description || "").trim();
  if (!title) throw new HttpError(400, "Title is required.");
  if (!description) throw new HttpError(400, "Description is required.");
  const job = await JobListing.create({
    title,
    department: payload.department || null,
    location: payload.location || null,
    employment_type: payload.employment_type || null,
    description,
    apply_email: payload.apply_email || null,
    apply_url: payload.apply_url || null,
    is_active: payload.is_active === "on" || payload.is_active === true,
  });
  await logAction({ actor, action: "create_job_listing", targetType: "job_listing", targetId: job.id, details: { title } });
  return { id: job.id };
}

export async function updateJobListing(id, payload, actor) {
  const job = await JobListing.findByPk(id);
  if (!job) throw new HttpError(404, "Job listing not found");
  const title = (payload.title || "").trim();
  const description = (payload.description || "").trim();
  if (!title) throw new HttpError(400, "Title is required.");
  if (!description) throw new HttpError(400, "Description is required.");
  job.title = title;
  job.department = payload.department || null;
  job.location = payload.location || null;
  job.employment_type = payload.employment_type || null;
  job.description = description;
  job.apply_email = payload.apply_email || null;
  job.apply_url = payload.apply_url || null;
  job.is_active = payload.is_active === "on" || payload.is_active === true;
  await job.save();
  await logAction({ actor, action: "update_job_listing", targetType: "job_listing", targetId: id });
  return { id: job.id };
}

export async function deleteJobListing(id, actor) {
  const job = await JobListing.findByPk(id);
  if (!job) throw new HttpError(404, "Job listing not found");
  await job.destroy();
  await logAction({ actor, action: "delete_job_listing", targetType: "job_listing", targetId: id });
  return { deleted: id };
}
