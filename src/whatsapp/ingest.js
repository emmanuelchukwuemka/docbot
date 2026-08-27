// Inbound message ingestion — the Baileys equivalent of the old Cloud API /webhook route.
// Baileys delivers messages over its own WebSocket (see baileysClient.js's
// `messages.upsert` handler) instead of an HTTP webhook, so there's no signature
// verification or hub-challenge concept here; every message we receive already came over
// our own authenticated WhatsApp Web session.

import { Conversation, Message, User } from "../db/models.js";
import { ConversationManager } from "../conversation/manager.js";
import { logger } from "../logger.js";

async function getOrCreateUser(waId, profileName) {
  let user = await User.findOne({ where: { whatsapp_number: waId } });
  if (!user) user = await User.create({ whatsapp_number: waId, name: profileName || null });
  return user;
}

async function getOrCreateOpenConversation(user) {
  let conversation = await Conversation.findOne({ where: { user_id: user.id }, order: [["created_at", "DESC"]] });
  if (!conversation || conversation.state === "ended") {
    conversation = await Conversation.create({ user_id: user.id, state: "welcome" });
  }
  return conversation;
}

/** Returns {text, interactiveId}. */
function extractInboundText(m) {
  if (m.conversation) return { text: m.conversation, interactiveId: null };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, interactiveId: null };
  if (m.buttonsResponseMessage) {
    return {
      text: m.buttonsResponseMessage.selectedDisplayText || "",
      interactiveId: m.buttonsResponseMessage.selectedButtonId || null,
    };
  }
  if (m.listResponseMessage) {
    return {
      text: m.listResponseMessage.title || "",
      interactiveId: m.listResponseMessage.singleSelectReply?.selectedRowId || null,
    };
  }
  if (m.templateButtonReplyMessage) {
    return {
      text: m.templateButtonReplyMessage.selectedDisplayText || "",
      interactiveId: m.templateButtonReplyMessage.selectedId || null,
    };
  }
  return { text: `[unsupported message type: ${Object.keys(m)[0]}]`, interactiveId: null };
}

/** FR-08 document upload. WhatsApp sends `documentMessage` for files and `imageMessage` for
 * photos of documents (both common for e.g. a passport photo) — treat both as an upload. */
function extractMedia(m) {
  if (m.documentMessage) {
    return {
      mimeType: m.documentMessage.mimetype,
      filename: m.documentMessage.fileName || "whatsapp_document",
    };
  }
  if (m.imageMessage) {
    return { mimeType: m.imageMessage.mimetype, filename: "whatsapp_image" };
  }
  return null;
}

export function createIngestHandler({ whatsappClient, conversationManager }) {
  const manager = conversationManager || new ConversationManager({ whatsappClient });

  return async function handleIncomingMessage(waId, waMessage) {
    const content = waMessage.message;
    if (!content) return;

    const profileName = waMessage.pushName || null;
    const user = await getOrCreateUser(waId, profileName);
    const conversation = await getOrCreateOpenConversation(user);

    const media = extractMedia(content);
    const text = media ? `[uploaded ${media.filename}]` : extractInboundText(content).text;

    await Message.create({
      conversation_id: conversation.id,
      direction: "inbound",
      sender: "user",
      text,
      raw_payload: { key: waMessage.key, messageType: Object.keys(content)[0] },
    });

    if (media) {
      const bytes = await whatsappClient.downloadMedia(waMessage);
      await manager.handleDocumentUpload(user, conversation, {
        content: bytes,
        mimeType: media.mimeType,
        filename: media.filename,
        whatsappMediaId: waMessage.key.id,
      });
    } else {
      const { interactiveId } = extractInboundText(content);
      await manager.handleInbound(user, conversation, text, interactiveId);
    }
  };
}

/** Wired to WhatsAppClient's onDeliveryError — corrects an outbound Message row from its
 * default (unverified "sent") to a known "failed" once WhatsApp's async ack rejects it. */
export async function handleDeliveryError(waMessageId, errorCode) {
  if (!waMessageId) return;
  const [count] = await Message.update(
    { delivery_status: "failed", delivery_error: errorCode == null ? null : String(errorCode) },
    { where: { whatsapp_message_id: waMessageId } }
  );
  if (count) {
    logger.warn({ waMessageId, errorCode }, "WhatsApp rejected delivery of an outbound message");
  }
}

export { extractInboundText, extractMedia };
