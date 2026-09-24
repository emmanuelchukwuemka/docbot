// Shared case-messaging helpers — the direct agent<->client chat thread on a given case
// (Application). Deliberately its own small module rather than living inside portal/ or
// vendors/: both sides (and admin/service.js, for staff read-only oversight) need the exact
// same read/write logic, and putting it in either feature module would mean one importing
// from the other for no real reason.

import { Application, CaseMessage } from "../db/models.js";
import { HttpError } from "../admin/httpError.js";

export async function listCaseMessages(applicationId) {
  const messages = await CaseMessage.findAll({
    where: { application_id: applicationId },
    order: [["created_at", "ASC"]],
  });
  return messages.map((m) => ({
    id: m.id,
    sender_type: m.sender_type,
    sender_id: m.sender_id,
    body: m.body,
    read_at: m.read_at ? m.read_at.toISOString() : null,
    created_at: m.created_at.toISOString(),
  }));
}

/** senderType is "user" or "vendor" — callers are responsible for having already verified
 * senderId actually owns/is-assigned-to this application before calling this (see
 * vendors/service.js and portal/service.js) — this function itself only checks the case
 * exists, not who's allowed to post to it. */
export async function postCaseMessage(applicationId, senderType, senderId, body) {
  const text = (body || "").trim();
  if (!text) throw new HttpError(400, "Message cannot be empty.");
  if (!["user", "vendor"].includes(senderType)) throw new HttpError(400, "Invalid sender type.");

  const application = await Application.findByPk(applicationId);
  if (!application) throw new HttpError(404, "Case not found.");

  const message = await CaseMessage.create({
    application_id: applicationId,
    sender_type: senderType,
    sender_id: senderId,
    body: text,
  });
  return { id: message.id, created_at: message.created_at.toISOString() };
}

/** Marks the other side's messages as read (a user reading marks vendor messages read, and
 * vice versa) — never marks the reader's own messages, which would be meaningless. */
export async function markCaseMessagesRead(applicationId, readerType) {
  const otherType = readerType === "vendor" ? "user" : "vendor";
  await CaseMessage.update(
    { read_at: new Date() },
    { where: { application_id: applicationId, sender_type: otherType, read_at: null } }
  );
}

export async function countUnreadCaseMessages(applicationId, readerType) {
  const otherType = readerType === "vendor" ? "user" : "vendor";
  return CaseMessage.count({ where: { application_id: applicationId, sender_type: otherType, read_at: null } });
}
