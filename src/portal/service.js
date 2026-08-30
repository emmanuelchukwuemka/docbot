// Web self-service portal — register/login/dashboard data. Shares the `users` table with
// the WhatsApp bot (src/whatsapp/ingest.js) rather than a separate table: a person who
// registers on the web with the same WhatsApp number they've messaged the bot from should
// see the one profile/leads/documents/payments the bot already has for them, not a second,
// disconnected identity. A non-null password_hash is what distinguishes "has a portal
// account" from "just a WhatsApp contact" — see deps.js's getSessionUser.

import { Op } from "sequelize";
import { Application, ConsultationBooking, ContactMessage, Country, Document, Pathway, Payment, User } from "../db/models.js";
import { hashPassword, verifyPassword } from "../security/passwords.js";
import { RateLimiter } from "../security/rateLimiter.js";
import { HttpError } from "../admin/httpError.js";
import { combinePhoneNumber, isValidEmail, isValidPassword, phoneToWhatsappNumber } from "./validation.js";
import { APPLICATION_STAGE_LABELS, APPLICATION_STAGE_ORDER } from "../conversation/manager.js";
import { generateChecklist } from "../documents/checklist.js";
import { assess, EligibilityResultType } from "../eligibility/engine.js";
import { hasPaidTier } from "../payments/tierAccess.js";
import { settings } from "../config.js";

// Per-identifier (not per-IP) login guard — same spirit as whatsapp/ingest.js's inbound
// rate limiter, keyed on the thing being targeted rather than plumbing req.ip through every
// caller. 8 attempts / 10 minutes is enough for a genuine typo or two without being a usable
// password-guessing budget.
const loginLimiter = new RateLimiter({ max: 8, windowMs: 10 * 60_000 });
// Separate, looser guard against spinning up accounts in bulk from one place.
const registerLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60_000 });

export async function registerUser(
  { name, email, whatsapp_dial_code, whatsapp_local_number, country, state, password, password_confirm },
  ip = "_"
) {
  if (!registerLimiter.consume(ip)) {
    throw new HttpError(429, "Too many registration attempts from here — try again later.");
  }

  const name_ = (name || "").trim();
  const email_ = (email || "").trim().toLowerCase();
  const country_ = (country || "").trim();
  const state_ = (state || "").trim();

  if (!name_) throw new HttpError(400, "Name is required.");
  if (!isValidEmail(email_)) throw new HttpError(400, "Enter a valid email address.");
  if (!country_) throw new HttpError(400, "Country is required.");
  if (!isValidPassword(password)) throw new HttpError(400, "Password must be at least 8 characters.");
  // Client-side JS already checks this instantly, but a form POST is easy to replay/script
  // past that, so the actual guarantee lives here.
  if (password !== password_confirm) throw new HttpError(400, "Passwords don't match.");

  const whatsapp_number = combinePhoneNumber(whatsapp_dial_code, whatsapp_local_number);
  if (!whatsapp_number) {
    throw new HttpError(400, "Enter a valid WhatsApp number.");
  }

  const emailOwner = await User.findOne({ where: { email: email_, password_hash: { [Op.ne]: null } } });
  if (emailOwner && emailOwner.whatsapp_number !== whatsapp_number) {
    throw new HttpError(409, "An account with this email already exists.");
  }

  let user = await User.findOne({ where: { whatsapp_number } });
  if (user) {
    if (user.password_hash) {
      throw new HttpError(409, "An account with this WhatsApp number already exists — log in instead.");
    }
    // Claim the existing WhatsApp-bot-created row instead of duplicating it, so this
    // person's prior conversation/leads/documents/payments carry over to their new account.
    user.name = name_;
    user.email = email_;
    user.country = country_;
    user.state = state_;
    user.password_hash = hashPassword(password);
    await user.save();
  } else {
    user = await User.create({
      whatsapp_number,
      name: name_,
      email: email_,
      country: country_,
      state: state_,
      password_hash: hashPassword(password),
    });
  }
  return user;
}

export async function authenticateUser(identifier, password) {
  const id = (identifier || "").trim();
  if (!id || !password) throw new HttpError(400, "Email/WhatsApp number and password are required.");

  if (!loginLimiter.consume(id.toLowerCase())) {
    throw new HttpError(429, "Too many login attempts — try again in a few minutes.");
  }

  const looksLikeEmail = id.includes("@") && isValidEmail(id);
  const where = looksLikeEmail
    ? { email: id.toLowerCase(), password_hash: { [Op.ne]: null } }
    : { whatsapp_number: phoneToWhatsappNumber(id), password_hash: { [Op.ne]: null } };

  const user = await User.findOne({ where });
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, "Incorrect email/WhatsApp number or password.");
  }
  return user;
}

/** Same email-or-WhatsApp-number lookup as authenticateUser(), without the password check —
 * for "forgot password". Deliberately does NOT throw "not found" (that would let someone
 * probe which emails/numbers have accounts) — callers should show the same "if that account
 * exists, a code was sent" message regardless of the result. */
export async function findRegisteredUserByIdentifier(identifier) {
  const id = (identifier || "").trim();
  if (!id) return null;
  const looksLikeEmail = id.includes("@") && isValidEmail(id);
  const where = looksLikeEmail
    ? { email: id.toLowerCase(), password_hash: { [Op.ne]: null } }
    : { whatsapp_number: phoneToWhatsappNumber(id), password_hash: { [Op.ne]: null } };
  return User.findOne({ where });
}

export async function setNewPassword(userId, newPassword) {
  if (!isValidPassword(newPassword)) throw new HttpError(400, "Password must be at least 8 characters.");
  const user = await User.findByPk(userId);
  if (!user) throw new HttpError(404, "Account not found.");
  user.password_hash = hashPassword(newPassword);
  await user.save();
}

/** Real, defensible progress: position of `stage` in the same fixed 7-stage sequence the
 * bot itself advances applications through (conversation/manager.js), not an invented
 * number. Stage 1 of 7 = 14%, not "roughly a third done" or anything a real applicant
 * could reasonably be misled by. */
function stageProgressPercent(stage) {
  const idx = APPLICATION_STAGE_ORDER.indexOf(stage);
  if (idx === -1) return 0;
  return Math.round(((idx + 1) / APPLICATION_STAGE_ORDER.length) * 100);
}

/** Real recent-activity feed, built by merging the timestamped events that already exist
 * across documents/applications/consultations/payments — nothing stored or fabricated
 * separately, just sorted by when it actually happened. */
function buildActivityFeed({ documents, applications, consultations, payments }) {
  const events = [];
  for (const d of documents) {
    if (!d.uploaded_at) continue;
    const verb = d.verification_status === "verified" ? "verified" : d.verification_status === "rejected" ? "rejected" : "received";
    events.push({ at: d.uploaded_at, text: `Document "${d.document_type}" was ${verb}.`, kind: verb === "verified" ? "good" : verb === "rejected" ? "bad" : "neutral" });
  }
  for (const a of applications) {
    events.push({ at: a.updated_at, text: `Your application moved to ${APPLICATION_STAGE_LABELS[a.stage] || a.stage}.`, kind: "neutral" });
  }
  for (const c of consultations) {
    if (c.status === "requested") continue; // not really "news" — it's the user's own action
    events.push({ at: c.updated_at, text: `Your consultation is ${c.status}.`, kind: c.status === "confirmed" ? "good" : "neutral" });
  }
  for (const p of payments) {
    if (p.status !== "paid" || !p.paid_at) continue;
    events.push({ at: p.paid_at, text: `Payment confirmed for "${p.purpose}".`, kind: "good" });
  }
  return events
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 6)
    .map((e) => ({ text: e.text, kind: e.kind, at: new Date(e.at).toISOString() }));
}

/** Pathways the user's own profile might genuinely fit, using the same eligibility engine
 * the WhatsApp bot itself uses (src/eligibility/engine.js) — deliberately not a % match
 * score; only pathways the engine calls "potentially suitable" are shown, each with the
 * engine's own real reasons, capped at 4 so this stays a shortlist, not a dump of the
 * whole knowledge base. */
async function recommendedPathways(profile, alreadyAppliedPathwayIds) {
  if (!profile || !profile.destination_country) return [];
  const country = await Country.findOne({ where: { name: profile.destination_country } });
  if (!country) return [];

  // assess() only checks field-completeness + red flags for whatever category the pathway
  // itself is — it doesn't know the user's stated goal, so without this filter someone who
  // said "work" could pass a Study pathway's (unrelated) completeness check and see it
  // "recommended" despite contradicting what they actually asked for.
  const where = { country_id: country.id };
  if (profile.migration_objective) where.category = profile.migration_objective;

  const pathways = await Pathway.findAll({ where, include: [{ model: Country, as: "country" }] });
  const results = [];
  for (const pathway of pathways) {
    if (alreadyAppliedPathwayIds.has(pathway.id)) continue;
    const assessment = assess(profile, pathway);
    if (assessment.result !== EligibilityResultType.POTENTIALLY_SUITABLE) continue;
    results.push({
      id: pathway.id,
      name: pathway.name,
      country: pathway.country.name,
      category: pathway.category,
      summary: pathway.summary,
      reasons: assessment.reasons,
    });
    if (results.length >= 4) break;
  }
  return results;
}

/** Everything the account dashboard shows. Deliberately excludes Lead (score/classification
 * like HOT/WARM/COLD) — that's an internal sales-scoring concept, not something to show the
 * person it's scoring. */
export async function getDashboardData(userId) {
  const user = await User.findByPk(userId, { include: [{ association: "profile" }] });
  if (!user) throw new HttpError(404, "Account not found.");

  const applications = await Application.findAll({
    where: { user_id: userId },
    order: [["updated_at", "DESC"]],
    include: [{ association: "pathway", include: [{ model: Country, as: "country" }] }],
  });

  const documents = await Document.findAll({ where: { user_id: userId }, order: [["uploaded_at", "DESC"]] });
  const payments = await Payment.findAll({ where: { user_id: userId }, order: [["created_at", "DESC"]] });
  const consultations = await ConsultationBooking.findAll({ where: { user_id: userId }, order: [["created_at", "DESC"]] });

  // Document checklist for whichever application was touched most recently — the one
  // real "what do I still need to do" view, built from the pathway's own real
  // requirements (documents/checklist.js), same generator the WhatsApp bot uses.
  const primaryApplication = applications.find((a) => a.pathway) || null;
  const checklist = primaryApplication
    ? generateChecklist(primaryApplication.pathway, documents).items
    : [];
  const checklistPending = checklist.filter((item) => item.status === "missing" || item.status === "rejected").length;

  const recommendations = await recommendedPathways(
    user.profile,
    new Set(applications.filter((a) => a.pathway_id).map((a) => a.pathway_id))
  );

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      whatsapp_number: user.whatsapp_number,
      country: user.country,
      state: user.state,
      created_at: user.created_at ? user.created_at.toISOString() : null,
    },
    profile: user.profile
      ? {
          destination_country: user.profile.destination_country,
          migration_objective: user.profile.migration_objective,
          timeline: user.profile.timeline,
          financial_readiness: user.profile.financial_readiness,
        }
      : null,
    progressPercent: primaryApplication ? stageProgressPercent(primaryApplication.stage) : 0,
    applications: applications.map((a) => ({
      id: a.id,
      country: a.pathway ? a.pathway.country.name : null,
      pathwayName: a.pathway ? a.pathway.name : null,
      stage: a.stage,
      stageLabel: APPLICATION_STAGE_LABELS[a.stage] || a.stage,
      progressPercent: stageProgressPercent(a.stage),
      status: a.status,
      assigned_specialist: a.assigned_specialist,
      updated_at: a.updated_at.toISOString(),
    })),
    documents: documents.map((d) => ({
      id: d.id,
      document_type: d.document_type,
      status: d.status,
      verification_status: d.verification_status,
      uploaded_at: d.uploaded_at ? d.uploaded_at.toISOString() : null,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      purpose: p.purpose,
      amount: Number(p.amount),
      currency: p.currency,
      status: p.status,
      tier: p.tier,
      reference: p.reference,
      paid_at: p.paid_at ? p.paid_at.toISOString() : null,
      created_at: p.created_at.toISOString(),
    })),
    hasNavigateTier: await hasPaidTier(userId, "navigate"),
    navigatePriceNgn: settings.navigatePriceNgn,
    paystackConfigured: settings.paystackConfigured,
    consultations: consultations.map((c) => ({
      id: c.id,
      preferred_time_text: c.preferred_time_text,
      status: c.status,
      created_at: c.created_at.toISOString(),
      updated_at: c.updated_at.toISOString(),
    })),
    checklist,
    checklistPending,
    checklistFor: primaryApplication
      ? { country: primaryApplication.pathway.country.name, pathway: primaryApplication.pathway.name }
      : null,
    recommendations,
    activity: buildActivityFeed({ documents, applications, consultations, payments }),
  };
}

/** Same shape as the WhatsApp bot's own booking (conversation/manager.js) minus
 * conversation_id, which only applies to a WhatsApp-originated booking. */
export async function bookConsultation(userId, { preferred_time_text, contact_email }) {
  const text = (preferred_time_text || "").trim();
  if (!text) throw new HttpError(400, "Let us know your preferred time.");
  const user = await User.findByPk(userId);
  if (!user) throw new HttpError(404, "Account not found.");

  const email = (contact_email || "").trim() || user.email;
  const booking = await ConsultationBooking.create({
    user_id: userId,
    preferred_time_text: text,
    contact_email: email,
    status: "requested",
  });
  return { id: booking.id, status: booking.status };
}

// Same per-identifier rate-limit shape as login/register — keyed on IP since a contact
// message sender may not be logged in at all.
const contactLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60_000 });

/** The /contact page's "send us a message" option — works whether or not the sender is
 * logged in. `sessionUser` (or null) decides whether name/email/whatsapp are trusted from
 * the session or taken from the form. */
export async function submitContactMessage(payload, sessionUser, ip = "_") {
  if (!contactLimiter.consume(ip)) {
    throw new HttpError(429, "Too many messages sent from here — try again later, or use WhatsApp instead.");
  }

  const message = (payload.message || "").trim();
  if (!message) throw new HttpError(400, "Enter a message.");

  const name = sessionUser ? sessionUser.name || "MigraTech client" : (payload.name || "").trim();
  if (!name) throw new HttpError(400, "Name is required.");

  const email = sessionUser ? sessionUser.email : (payload.email || "").trim() || null;
  if (email && !isValidEmail(email)) throw new HttpError(400, "Enter a valid email address.");

  const record = await ContactMessage.create({
    user_id: sessionUser ? sessionUser.id : null,
    name,
    email,
    whatsapp_number: sessionUser ? sessionUser.whatsapp_number : null,
    message,
    status: "new",
  });
  return { id: record.id };
}

// --------------------------------------------------------------------------- //
// Account settings — self-service profile edits. Password and WhatsApp number changes are
// deliberately separate functions from updateProfile(), each with its own real guard
// (current-password check; re-verification for a number change), rather than one big form
// silently allowing either as a side effect of "save".
// --------------------------------------------------------------------------- //

export async function updateProfile(userId, { name, email, country, state }) {
  const user = await User.findByPk(userId);
  if (!user) throw new HttpError(404, "Account not found.");

  const name_ = (name || "").trim();
  const email_ = (email || "").trim().toLowerCase();
  if (!name_) throw new HttpError(400, "Name is required.");
  if (!isValidEmail(email_)) throw new HttpError(400, "Enter a valid email address.");

  if (email_ !== user.email) {
    const owner = await User.findOne({ where: { email: email_, password_hash: { [Op.ne]: null } } });
    if (owner && owner.id !== user.id) throw new HttpError(409, "Another account already uses this email.");
  }

  user.name = name_;
  user.email = email_;
  user.country = (country || "").trim() || user.country;
  user.state = (state || "").trim();
  await user.save();
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await User.findByPk(userId);
  if (!user) throw new HttpError(404, "Account not found.");
  if (!verifyPassword(currentPassword || "", user.password_hash)) {
    throw new HttpError(401, "Current password is incorrect.");
  }
  if (!isValidPassword(newPassword)) throw new HttpError(400, "New password must be at least 8 characters.");
  user.password_hash = hashPassword(newPassword);
  await user.save();
}

/** Changing the WhatsApp number that identifies this account. Doesn't touch is_verified —
 * the account stays verified (they already proved control of the *old* number, and this
 * change itself requires their current password), but a fresh OTP flow for the new number
 * would be the more airtight version of this; left as a known gap rather than blocking the
 * feature on building that too. */
export async function changeWhatsappNumber(userId, currentPassword, dialCode, localNumber) {
  const user = await User.findByPk(userId);
  if (!user) throw new HttpError(404, "Account not found.");
  if (!verifyPassword(currentPassword || "", user.password_hash)) {
    throw new HttpError(401, "Current password is incorrect.");
  }
  const whatsapp_number = combinePhoneNumber(dialCode, localNumber);
  if (!whatsapp_number) throw new HttpError(400, "Enter a valid WhatsApp number.");
  if (whatsapp_number === user.whatsapp_number) return;

  const existing = await User.findOne({ where: { whatsapp_number } });
  if (existing && existing.id !== user.id) {
    throw new HttpError(409, "That WhatsApp number is already linked to a different account.");
  }
  user.whatsapp_number = whatsapp_number;
  await user.save();
}
