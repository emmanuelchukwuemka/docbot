// Partner-agent (Vendor) business logic — application intake, auth, dashboard/case data,
// messaging, and the commission ledger view. Mirrors portal/service.js's shape (same
// validation/rate-limit/HttpError conventions) but for the vendor's own account, not a
// migrant's.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { Application, CaseMessage, Commission, Country, Pathway, ConsultationBooking, Document, User, Vendor, VendorDocument } from "../db/models.js";
import { settings } from "../config.js";
import { logger } from "../logger.js";
import { HttpError } from "../admin/httpError.js";
import { hashPassword, verifyPassword } from "../security/passwords.js";
import { RateLimiter } from "../security/rateLimiter.js";
import { combinePhoneNumber, isValidEmail, isValidPassword } from "../portal/validation.js";
import { countUnreadCaseMessages, listCaseMessages, markCaseMessagesRead, postCaseMessage } from "../cases/messaging.js";
import { LocalEncryptedStorage } from "../documents/storage.js";

const applyLimiter = new RateLimiter({ max: 5, windowMs: 60 * 60_000 });
const loginLimiter = new RateLimiter({ max: 8, windowMs: 10 * 60_000 });

// Profile photos are publicly viewable but, critically, NOT stored under src/public — that
// directory is baked into the Docker image at build time and replaced on every deploy (see
// config.js's vendorPhotoStorageDir comment), so anything written there at runtime would be
// wiped on the next deploy. This uses the same persistent-volume pattern as
// documentStorageDir; server.js serves it via a dedicated static route rather than the
// general src/public one.
const PHOTO_DIR = path.resolve(settings.vendorPhotoStorageDir);
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB — resized down regardless, this just bounds upload abuse
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // 10MB per verification document

/** Resizes to a sensible avatar size and writes to disk. Returns the public URL
 * (/vendor-photos/<file>) to store on Vendor.photo_url. Old photo (if any) is deleted so
 * repeated re-uploads don't silently accumulate orphaned files on disk forever. */
async function savePhoto(vendor, file) {
  if (!file) return null;
  if (file.size > MAX_PHOTO_BYTES) throw new HttpError(400, "Photo is too large (max 5MB).");
  if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
    throw new HttpError(400, "Photo must be a JPEG, PNG, or WEBP image.");
  }

  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const filename = `${crypto.randomBytes(12).toString("hex")}.jpg`;
  const outPath = path.join(PHOTO_DIR, filename);
  await sharp(file.buffer).resize({ width: 400, height: 400, fit: "cover" }).jpeg({ quality: 85 }).toFile(outPath);

  if (vendor.photo_url) {
    const oldPath = path.join(PHOTO_DIR, path.basename(vendor.photo_url));
    fs.rm(oldPath, { force: true }, () => {});
  }

  return `/vendor-photos/${filename}`;
}

/** Verification documents (ID, license, certification) are genuinely sensitive — encrypted
 * at rest via the same LocalEncryptedStorage used for migrant-facing Document uploads, not
 * publicly servable. Only staff (admin/service.js) can decrypt/view these. */
async function saveVerificationDocuments(vendorId, files) {
  if (!files || !files.length) return [];
  const storage = new LocalEncryptedStorage();
  const created = [];
  for (const file of files) {
    if (file.size > MAX_DOCUMENT_BYTES) throw new HttpError(400, `"${file.originalname}" is too large (max 10MB).`);
    const filePath = storage.save(vendorId, file.originalname, file.buffer);
    const doc = await VendorDocument.create({
      vendor_id: vendorId,
      document_type: "Verification Document",
      file_location: filePath,
      original_filename: file.originalname,
      mime_type: file.mimetype,
    });
    created.push(doc);
  }
  return created;
}

// --------------------------------------------------------------------------- //
// Application (to become a vendor) + auth
// --------------------------------------------------------------------------- //

export async function submitVendorApplication(payload, files = {}, ip = "_") {
  if (!applyLimiter.consume(ip)) {
    throw new HttpError(429, "Too many applications submitted from here — try again later.");
  }

  const name = (payload.name || "").trim();
  const business_name = (payload.business_name || "").trim();
  const email = (payload.email || "").trim().toLowerCase();
  const countries_covered = (payload.countries_covered || "").trim();
  const services_offered = (payload.services_offered || "").trim();
  const message = (payload.message || "").trim();

  if (!name) throw new HttpError(400, "Name is required.");
  if (!isValidEmail(email)) throw new HttpError(400, "Enter a valid email address.");
  if (!isValidPassword(payload.password)) throw new HttpError(400, "Password must be at least 8 characters.");
  if (payload.password !== payload.password_confirm) throw new HttpError(400, "Passwords don't match.");

  const existing = await Vendor.findOne({ where: { email } });
  if (existing) throw new HttpError(409, "An application with this email already exists.");

  const whatsapp_number = combinePhoneNumber(payload.whatsapp_dial_code, payload.whatsapp_local_number);
  if (!whatsapp_number) throw new HttpError(400, "Enter a valid WhatsApp number.");

  const service_categories = Array.isArray(payload.service_categories)
    ? payload.service_categories
    : payload.service_categories
    ? [payload.service_categories]
    : [];

  const vendor = await Vendor.create({
    name,
    business_name: business_name || null,
    whatsapp_number,
    email,
    password_hash: hashPassword(payload.password),
    countries_covered: countries_covered || null,
    service_categories,
    services_offered: services_offered || null,
    message: message || null,
    status: "pending",
  });

  // Photo/documents are optional and handled after the core row exists — a failed upload
  // (bad file type, too large) shouldn't cost the applicant their whole submission when the
  // rest of the form was valid; it just leaves the photo/documents empty for now, addable
  // later from the profile page.
  try {
    const photoFile = files.photo?.[0];
    if (photoFile) {
      vendor.photo_url = await savePhoto(vendor, photoFile);
      await vendor.save();
    }
    if (files.documents?.length) {
      await saveVerificationDocuments(vendor.id, files.documents);
    }
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    // Swallow upload-specific validation errors here — the application itself already
    // succeeded and got a real ID; surfacing this as a hard failure would be confusing
    // ("my application failed" when it didn't). Logged so staff/ops can still notice.
    logger.error({ err, vendorId: vendor.id }, "Vendor application photo/document upload failed");
  }

  // Best-effort — an application that isn't instantly flagged to staff still sits safely in
  // the admin dashboard's Agents tab either way, same reasoning as every other
  // fire-and-forget staff webhook in this codebase (see e.g. scheduler.js).
  if (settings.staffNotificationWebhookUrl) {
    fetch(settings.staffNotificationWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "vendor_application", vendor_id: vendor.id, name, email }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  return { id: vendor.id };
}

export async function authenticateVendor(email, password) {
  const id = (email || "").trim().toLowerCase();
  if (!id || !password) throw new HttpError(400, "Email and password are required.");

  if (!loginLimiter.consume(id)) {
    throw new HttpError(429, "Too many login attempts — try again in a few minutes.");
  }

  const vendor = await Vendor.findOne({ where: { email: id } });
  if (!vendor || !verifyPassword(password, vendor.password_hash)) {
    throw new HttpError(401, "Incorrect email or password.");
  }
  if (vendor.status === "pending") {
    throw new HttpError(403, "Your application is still under review — we'll email you once it's approved.");
  }
  if (vendor.status === "rejected" || vendor.status === "suspended") {
    throw new HttpError(403, "This account isn't active. Contact MigraTech support if you think that's wrong.");
  }
  return vendor;
}

// --------------------------------------------------------------------------- //
// Profile
// --------------------------------------------------------------------------- //

export async function updateVendorProfile(vendorId, payload, photoFile = null) {
  const vendor = await Vendor.findByPk(vendorId);
  if (!vendor) throw new HttpError(404, "Account not found.");

  const name = (payload.name || "").trim();
  if (!name) throw new HttpError(400, "Name is required.");

  const service_categories = Array.isArray(payload.service_categories)
    ? payload.service_categories
    : payload.service_categories
    ? [payload.service_categories]
    : [];

  vendor.name = name;
  vendor.business_name = (payload.business_name || "").trim() || null;
  vendor.countries_covered = (payload.countries_covered || "").trim() || null;
  vendor.service_categories = service_categories;
  vendor.services_offered = (payload.services_offered || "").trim() || null;
  if (photoFile) vendor.photo_url = await savePhoto(vendor, photoFile);
  await vendor.save();
  return { id: vendor.id };
}

export async function addVendorDocuments(vendorId, files) {
  const vendor = await Vendor.findByPk(vendorId);
  if (!vendor) throw new HttpError(404, "Account not found.");
  if (!files || !files.length) throw new HttpError(400, "Choose at least one file to upload.");
  await saveVerificationDocuments(vendorId, files);
  return { id: vendorId };
}

export async function listVendorVerificationDocuments(vendorId) {
  const docs = await VendorDocument.findAll({ where: { vendor_id: vendorId }, order: [["uploaded_at", "DESC"]] });
  return docs.map((d) => ({
    id: d.id,
    document_type: d.document_type,
    original_filename: d.original_filename,
    uploaded_at: d.uploaded_at.toISOString(),
  }));
}

export async function changeVendorPassword(vendorId, currentPassword, newPassword) {
  const vendor = await Vendor.findByPk(vendorId);
  if (!vendor) throw new HttpError(404, "Account not found.");
  if (!verifyPassword(currentPassword, vendor.password_hash)) {
    throw new HttpError(401, "Current password is incorrect.");
  }
  if (!isValidPassword(newPassword)) throw new HttpError(400, "New password must be at least 8 characters.");
  vendor.password_hash = hashPassword(newPassword);
  await vendor.save();
  return { id: vendor.id };
}

// --------------------------------------------------------------------------- //
// Dashboard / cases
// --------------------------------------------------------------------------- //

function effectiveCommissionRate(vendor) {
  return vendor.commission_rate_percent ?? settings.defaultCommissionRatePercent;
}

export async function getVendorDashboardSummary(vendorId) {
  const cases = await Application.findAll({ where: { vendor_id: vendorId } });
  const activeCases = cases.filter((c) => c.status === "in_progress").length;
  const completedCases = cases.filter((c) => c.stage === "decision").length;

  const commissions = await Commission.findAll({ where: { vendor_id: vendorId } });
  const totalOwed = commissions.filter((c) => c.status === "owed").reduce((sum, c) => sum + Number(c.amount), 0);
  const totalPaid = commissions.filter((c) => c.status === "paid").reduce((sum, c) => sum + Number(c.amount), 0);

  const consultationCount = cases.length
    ? await ConsultationBooking.count({ where: { user_id: cases.map((c) => c.user_id) } })
    : 0;

  return {
    totalCases: cases.length,
    activeCases,
    completedCases,
    consultationCount,
    totalOwed,
    totalPaid,
  };
}

export async function listVendorCases(vendorId) {
  const cases = await Application.findAll({
    where: { vendor_id: vendorId },
    order: [["updated_at", "DESC"]],
    include: [{ association: "user" }, { association: "pathway", include: [{ model: Country, as: "country" }] }],
  });
  return Promise.all(
    cases.map(async (c) => ({
      id: c.id,
      client_name: c.user.name,
      client_whatsapp: c.user.whatsapp_number,
      pathway: c.pathway ? `${c.pathway.country.name} — ${c.pathway.name}` : "—",
      stage: c.stage,
      status: c.status,
      unread_messages: await countUnreadCaseMessages(c.id, "vendor"),
      updated_at: c.updated_at.toISOString(),
    }))
  );
}

/** Throws 404 (not 403) if the case exists but isn't this vendor's — same "don't reveal
 * whether the resource exists" reasoning used elsewhere in this codebase for
 * cross-account access checks. */
export async function getVendorCase(vendorId, applicationId) {
  const application = await Application.findOne({
    where: { id: applicationId, vendor_id: vendorId },
    include: [{ association: "user" }, { association: "pathway", include: [{ model: Country, as: "country" }] }],
  });
  if (!application) throw new HttpError(404, "Case not found.");

  await markCaseMessagesRead(applicationId, "vendor");
  const messages = await listCaseMessages(applicationId);

  return {
    id: application.id,
    stage: application.stage,
    status: application.status,
    client: {
      id: application.user.id,
      name: application.user.name,
      whatsapp_number: application.user.whatsapp_number,
      email: application.user.email,
    },
    pathway: application.pathway ? `${application.pathway.country.name} — ${application.pathway.name}` : "—",
    messages,
  };
}

export async function sendCaseMessageAsVendor(vendorId, applicationId, body) {
  const application = await Application.findOne({ where: { id: applicationId, vendor_id: vendorId } });
  if (!application) throw new HttpError(404, "Case not found.");
  return postCaseMessage(applicationId, "vendor", vendorId, body);
}

export async function listVendorConsultations(vendorId) {
  const cases = await Application.findAll({ where: { vendor_id: vendorId }, attributes: ["user_id"] });
  const userIds = [...new Set(cases.map((c) => c.user_id))];
  if (!userIds.length) return [];
  const bookings = await ConsultationBooking.findAll({
    where: { user_id: userIds },
    order: [["created_at", "DESC"]],
    include: [{ association: "user" }],
  });
  return bookings.map((b) => ({
    id: b.id,
    client_name: b.user.name,
    preferred_time_text: b.preferred_time_text,
    status: b.status,
    created_at: b.created_at.toISOString(),
  }));
}

export async function listVendorDocuments(vendorId) {
  const cases = await Application.findAll({ where: { vendor_id: vendorId }, attributes: ["user_id"] });
  const userIds = [...new Set(cases.map((c) => c.user_id))];
  if (!userIds.length) return [];
  const docs = await Document.findAll({
    where: { user_id: userIds },
    order: [["uploaded_at", "DESC"]],
    include: [{ association: "user" }],
  });
  return docs.map((d) => ({
    id: d.id,
    client_name: d.user.name,
    document_type: d.document_type,
    status: d.status,
    verification_status: d.verification_status,
    uploaded_at: d.uploaded_at ? d.uploaded_at.toISOString() : null,
  }));
}

export async function listVendorEarnings(vendorId) {
  const vendor = await Vendor.findByPk(vendorId);
  if (!vendor) throw new HttpError(404, "Account not found.");

  const commissions = await Commission.findAll({
    where: { vendor_id: vendorId },
    order: [["created_at", "DESC"]],
    include: [{ association: "application", include: [{ association: "user" }] }],
  });

  return {
    commissionRatePercent: effectiveCommissionRate(vendor),
    entries: commissions.map((c) => ({
      id: c.id,
      client_name: c.application?.user?.name ?? "—",
      case_value: Number(c.case_value),
      rate_percent: c.rate_percent,
      amount: Number(c.amount),
      status: c.status,
      created_at: c.created_at.toISOString(),
      paid_at: c.paid_at ? c.paid_at.toISOString() : null,
    })),
  };
}
