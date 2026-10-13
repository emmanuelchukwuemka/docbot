// FR-13 Notifications & Reminders.
//
// Honest scope note: MigraTech hasn't given us a real calendar system (Google
// Calendar/Calendly) or task queue (BullMQ/Redis) to integrate with, so this uses
// node-cron running in-process — fine for a single-instance MVP deployment, not something
// to rely on if the app ever runs as multiple replicas (jobs would fire once per replica).
// Swap for a real scheduler + distributed lock before scaling out.
//
// Each run_* function is unit-testable on its own; `startScheduler` just wires them to a
// clock.

import cron from "node-cron";
import { Op } from "sequelize";
import { settings } from "./config.js";
import { logger } from "./logger.js";
import { Application, AuditLog, ConsultationBooking, Conversation, Document, Lead, Message, Pathway, Payment, User, Country } from "./db/models.js";
import { generateChecklist, renderChecklistWhatsappText } from "./documents/checklist.js";
import { findRelocateUrgentItem } from "./relocate/nudge.js";
import { inboundRateLimiter, sweepSeenMessageIds } from "./whatsapp/ingest.js";
import { aiRateLimiter } from "./ai/llmClient.js";

const DOCUMENT_REMINDER_INTERVAL_DAYS = 3;
const CONSULTATION_STAFF_REMINDER_AFTER_HOURS = 24;
const PAYMENT_REMINDER_INTERVAL_DAYS = 3;
// Paying Relocate subscribers, not pre-conversion Leads — a longer, distinct cadence from
// runMissingDocumentReminders' 3-day one.
const RELOCATE_REMINDER_INTERVAL_DAYS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extra pause between reminder sends, on top of whatsappClient.sendText's own SendQueue
 * pacing — see config.js's reasoning. Not called before the *first* send in a batch, only
 * between successive ones. */
function reminderGapMs() {
  return settings.reminderInterSendMinMs + Math.random() * settings.reminderInterSendJitterMs;
}

/** Reminders are bot-initiated, not a reply, so there's no "current" conversation the way
 * ingest.js has one mid-exchange — this just finds whichever conversation is already on
 * file for the log entry to attach to. Returns null (skip logging, don't fail the reminder
 * over it) if the user somehow has none yet. */
async function mostRecentConversationId(userId) {
  const conversation = await Conversation.findOne({ where: { user_id: userId }, order: [["created_at", "DESC"]] });
  return conversation ? conversation.id : null;
}

async function logReminderMessage(userId, text) {
  const conversationId = await mostRecentConversationId(userId);
  if (!conversationId) return;
  await Message.create({ conversation_id: conversationId, direction: "outbound", sender: "system_reminder", text });
}

export async function runMissingDocumentReminders(whatsappClient) {
  const cutoff = new Date(Date.now() - DOCUMENT_REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

  const leads = await Lead.findAll({
    where: {
      status: { [Op.notIn]: ["converted", "lost"] },
      [Op.or]: [{ last_reminder_sent_at: null }, { last_reminder_sent_at: { [Op.lt]: cutoff } }],
    },
    include: [{ association: "user", include: [{ association: "profile" }] }],
    // Anyone past the cap this run just gets picked up on the next scheduled run (their
    // last_reminder_sent_at is untouched) — see config.js's reminderBatchMaxPerRun.
    limit: settings.reminderBatchMaxPerRun,
  });

  let sent = 0;
  for (const lead of leads) {
    const profile = lead.user?.profile;
    if (!profile || !profile.destination_country || !profile.migration_objective) continue;

    const pathway = await Pathway.findOne({
      where: { category: profile.migration_objective },
      include: [{ model: Country, as: "country", where: { name: profile.destination_country } }],
    });
    if (!pathway || !(pathway.documents || []).length) continue;

    const documents = await Document.findAll({ where: { user_id: lead.user_id } });
    const checklist = generateChecklist(pathway, documents);
    const missing = checklist.items.filter((item) => item.status === "missing").map((item) => item.name);
    if (!missing.length) continue;

    if (sent > 0) await sleep(reminderGapMs());

    const missingText = missing.map((name) => `- ${name}`).join("\n");
    const text =
      "Friendly reminder from MigraTech: your document checklist for " +
      `${pathway.country.name} ${pathway.name} is still missing:\n${missingText}\n\n` +
      "Send them here whenever you're ready.";
    const result = await whatsappClient.sendText(lead.user.whatsapp_number, text);
    if (result?.skipped) continue; // rate-limited/disconnected — don't mark as reminded or log a send that didn't happen

    await logReminderMessage(lead.user_id, text);
    lead.last_reminder_sent_at = new Date();
    await lead.save();
    sent += 1;
  }
  return sent;
}

/** FR-13 payment reminders — nudges users about their own pending fee record(s) (see
 * Payment model's doc comment: a staff-maintained ledger, not a live payment gateway, so
 * this is a reminder to follow up/pay, not an automated charge). */
export async function runPaymentReminders(whatsappClient) {
  const cutoff = new Date(Date.now() - PAYMENT_REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

  const payments = await Payment.findAll({
    where: {
      status: "pending",
      created_at: { [Op.lt]: cutoff },
      [Op.or]: [{ last_reminder_sent_at: null }, { last_reminder_sent_at: { [Op.lt]: cutoff } }],
    },
    include: [{ association: "user" }],
    limit: settings.reminderBatchMaxPerRun,
  });

  let sent = 0;
  for (const payment of payments) {
    if (!payment.user) continue;

    if (sent > 0) await sleep(reminderGapMs());

    const text =
      `Friendly reminder from MigraTech: you have a pending payment of ${payment.currency} ` +
      `${Number(payment.amount).toLocaleString()} for "${payment.purpose}". ` +
      "Reply here or contact your MigraTech specialist to arrange payment.";
    const result = await whatsappClient.sendText(payment.user.whatsapp_number, text);
    if (result?.skipped) continue;

    await logReminderMessage(payment.user_id, text);
    payment.last_reminder_sent_at = new Date();
    await payment.save();
    sent += 1;
  }
  return sent;
}

/** Internal reminder to staff (not the user) for consultation requests that haven't been
 * picked up. We deliberately don't try to compute exact reminder timing against the user's
 * free-text preferred time — that needs real calendar parsing we don't have. */
export async function runConsultationStaffReminders() {
  if (!settings.staffNotificationWebhookUrl) return 0;

  const cutoff = new Date(Date.now() - CONSULTATION_STAFF_REMINDER_AFTER_HOURS * 60 * 60 * 1000);
  const bookings = await ConsultationBooking.findAll({
    where: { status: "requested", created_at: { [Op.lt]: cutoff }, staff_reminder_sent_at: null },
  });

  let sent = 0;
  for (const booking of bookings) {
    try {
      await fetch(settings.staffNotificationWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "consultation_overdue",
          booking_id: booking.id,
          user_id: booking.user_id,
          preferred_time_text: booking.preferred_time_text,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, "Failed to send consultation staff reminder");
      continue;
    }
    booking.staff_reminder_sent_at = new Date();
    await booking.save();
    sent += 1;
  }
  return sent;
}

/** Correctness sweep, not user-facing — flips a Document's status to "expired" once its
 * staff-entered expiry_date has passed, and resets verification_status back to "unreviewed"
 * (a verified-but-now-expired document's prior verification is void and needs re-review; this
 * doesn't invent a new verified/rejected stamp, just the existing neutral default). Idempotent
 * by construction: once flipped, a row no longer matches the WHERE clause. Deliberately a
 * separate job from runRelocateCaseReminders below — this is pure data correctness, that one
 * decides what to tell a user about it next. */
export async function runDocumentExpirySweep() {
  const documents = await Document.findAll({
    where: { expiry_date: { [Op.lt]: new Date() }, status: { [Op.ne]: "expired" } },
  });
  for (const document of documents) {
    document.status = "expired";
    document.verification_status = "unreviewed";
    await document.save();
  }
  return documents.length;
}

/** FR-13 proactive Relocate case reminders — unlike runMissingDocumentReminders (pre-
 * conversion Lead nurture), this targets paying Relocate subscribers and nudges them about
 * whatever single most urgent real thing is outstanding on their case (via the shared
 * findRelocateUrgentItem helper — same primitive the Relocate menu's stage hint uses). */
export async function runRelocateCaseReminders(whatsappClient) {
  const cutoff = new Date(Date.now() - RELOCATE_REMINDER_INTERVAL_DAYS * 24 * 60 * 60 * 1000);

  const relocatePayments = await Payment.findAll({ where: { tier: "relocate", status: "paid" }, attributes: ["user_id"] });
  const userIds = [...new Set(relocatePayments.map((p) => p.user_id))];

  let sent = 0;
  for (const userId of userIds) {
    const application = await Application.findOne({
      where: {
        user_id: userId,
        status: { [Op.ne]: "complete" },
        [Op.or]: [{ last_relocate_reminder_sent_at: null }, { last_relocate_reminder_sent_at: { [Op.lt]: cutoff } }],
      },
      order: [["created_at", "DESC"]],
      include: [{ association: "user" }],
    });
    if (!application || !application.user) continue;

    const pathway = application.pathway_id
      ? await Pathway.findByPk(application.pathway_id, { include: [{ model: Country, as: "country" }] })
      : null;
    const documents = await Document.findAll({ where: { user_id: userId } });
    const item = findRelocateUrgentItem(application, documents, pathway);
    if (!item) continue;

    let text;
    if (item.kind === "missing_documents") {
      text =
        `Your ${item.names[0]} is still outstanding. This is required before the next stage ` +
        'of your selected pathway. Reply "My Documents" to see your full checklist.';
    } else if (item.kind === "expired_document") {
      text = `Your ${item.name} has expired and needs to be renewed/resubmitted. Reply "My Documents" for your full checklist.`;
    } else if (item.kind === "inconsistent_document") {
      text = `Your ${item.name} needs attention${item.notes ? ` — ${item.notes}` : ""}. Reply "My Documents" for details.`;
    } else {
      continue;
    }

    if (sent > 0) await sleep(reminderGapMs());
    const result = await whatsappClient.sendText(application.user.whatsapp_number, text);
    if (result?.skipped) continue;

    await logReminderMessage(userId, text);
    application.last_relocate_reminder_sent_at = new Date();
    await application.save();
    sent += 1;
  }
  return sent;
}

/** Pure query, no side effects — user IDs whose most recent conversation activity is older
 * than the retention window and who aren't an active lead. Split out from
 * runDataRetentionCleanup so it's easy to unit test / dry-run without deleting. */
export async function findRetentionCandidates(retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const candidates = [];
  const users = await User.findAll();
  for (const user of users) {
    const latestConversation = await Conversation.findOne({
      where: { user_id: user.id },
      order: [["updated_at", "DESC"]],
    });
    const lastActive = latestConversation ? latestConversation.updated_at : user.created_at;
    if (lastActive >= cutoff) continue;

    const activeLead = await Lead.findOne({
      where: { user_id: user.id, status: { [Op.in]: ["qualified", "consultation_booked"] } },
    });
    if (activeLead) continue;

    candidates.push(user.id);
  }
  return candidates;
}

export async function runDataRetentionCleanup() {
  if (!settings.enableDataRetentionJob) return 0;

  const candidateIds = await findRetentionCandidates(settings.dataRetentionDays);
  for (const userId of candidateIds) {
    await AuditLog.create({
      actor: "system_retention_job",
      action: "delete_user_data",
      target_type: "user",
      target_id: userId,
      details: { reason: `inactive > ${settings.dataRetentionDays} days` },
    });
    const user = await User.findByPk(userId);
    if (user) await user.destroy();
  }
  return candidateIds.length;
}

/** Drops expired entries from the rate limiters' internal maps — see RateLimiter.sweep().
 * Without this, a long-running process accumulates one Map entry per WhatsApp number/
 * recipient that ever sent or received a message, even long after their window expired. */
function runRateLimiterSweep(whatsappClient) {
  inboundRateLimiter.sweep();
  aiRateLimiter.sweep();
  whatsappClient.outboundLimiter.sweep();
  whatsappClient.globalOutboundLimiter.sweep();
  sweepSeenMessageIds();
}

function guardedJob(name, fn) {
  return async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err }, `Scheduled job ${name} failed`);
    }
  };
}

/** Called once from server.js on startup. Returns the list of scheduled cron tasks so they
 * can be stopped cleanly, or [] if disabled. */
export function startScheduler(whatsappClient) {
  if (!settings.enableScheduler) {
    logger.info("Scheduler disabled (ENABLE_SCHEDULER=false).");
    return [];
  }

  const tasks = [
    cron.schedule("0 */6 * * *", guardedJob("document_reminders", () => runMissingDocumentReminders(whatsappClient))),
    cron.schedule("0 * * * *", guardedJob("consultation_reminders", runConsultationStaffReminders)),
    cron.schedule("0 9 * * *", guardedJob("payment_reminders", () => runPaymentReminders(whatsappClient))),
    cron.schedule("0 1 * * *", guardedJob("document_expiry_sweep", runDocumentExpirySweep)),
    cron.schedule("0 11 * * *", guardedJob("relocate_case_reminders", () => runRelocateCaseReminders(whatsappClient))),
    cron.schedule("0 0 * * *", guardedJob("data_retention", runDataRetentionCleanup)),
    cron.schedule("30 * * * *", guardedJob("rate_limiter_sweep", () => runRateLimiterSweep(whatsappClient))),
  ];
  logger.info(
    "Scheduler started (document reminders every 6h, consultation reminders hourly, " +
      "payment reminders daily at 9am, document expiry sweep daily at 1am, Relocate case " +
      "reminders daily at 11am, retention daily, rate-limiter sweep hourly)."
  );
  return tasks;
}
