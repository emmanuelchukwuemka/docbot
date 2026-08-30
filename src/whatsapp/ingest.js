// Inbound message ingestion — the Baileys equivalent of the old Cloud API /webhook route.
// Baileys delivers messages over its own WebSocket (see baileysClient.js's
// `messages.upsert` handler) instead of an HTTP webhook, so there's no signature
// verification or hub-challenge concept here; every message we receive already came over
// our own authenticated WhatsApp Web session.

import { Conversation, Message, User } from "../db/models.js";
import { ConversationManager } from "../conversation/manager.js";
import { logger } from "../logger.js";
import { settings } from "../config.js";
import { RateLimiter } from "../security/rateLimiter.js";

// Per-sender inbound cap — see config.js for why. Module-level so it persists across
// reconnects/relinks, which construct a fresh WhatsAppClient/ingest handler but should not
// reset anyone's rate-limit window.
export const inboundRateLimiter = new RateLimiter({
  max: settings.whatsappInboundRateLimitMax,
  windowMs: settings.whatsappInboundRateLimitWindowMs,
});

// Baileys can redeliver the same message on reconnect/session resume — without this, that
// redelivery would create a second Message row and trigger a second bot reply to something
// the user only sent once. In-memory + single-process, same MVP limit as inboundRateLimiter
// above (not safe to rely on across multiple replicas) — module-level so it survives ingest
// handler recreation across reconnects. 10 minutes comfortably covers a redelivery window
// without holding every message ID forever.
const SEEN_MESSAGE_ID_TTL_MS = 10 * 60_000;
const seenMessageIds = new Map(); // messageId -> firstSeenAt

/** Returns true (and records `messageId`) if it's already been seen within the TTL — the
 * caller should skip processing entirely. A message with no ID at all (shouldn't normally
 * happen) is never treated as a duplicate, since there's nothing reliable to key on. */
function isDuplicateMessage(messageId) {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.set(messageId, Date.now());
  return false;
}

/** Drops expired entries — same reasoning as RateLimiter.sweep(), called from the same
 * scheduled sweep job (see scheduler.js). */
export function sweepSeenMessageIds() {
  const cutoff = Date.now() - SEEN_MESSAGE_ID_TTL_MS;
  for (const [id, seenAt] of seenMessageIds) {
    if (seenAt < cutoff) seenMessageIds.delete(id);
  }
}

// Deliberately does NOT seed `name` from WhatsApp's own pushName — the bot asks for the
// user's name itself as part of the welcome flow (see conversation/manager.js's
// _handleWelcome/_handleCollectingName), same as a human assistant introducing themselves
// would, rather than silently inferring it from account metadata the user never confirmed.
async function getOrCreateUser(waId) {
  let user = await User.findOne({ where: { whatsapp_number: waId } });
  if (!user) user = await User.create({ whatsapp_number: waId });
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

  // Message debounce — if someone types a thought across 2-3 quick bubbles ("hi" then,
  // half a second later, "actually I want to move to Canada"), reacting to each the
  // instant it lands means replying to "hi" before the real message even arrives, on top
  // of being the same always-instant pattern flagged elsewhere in this file. Buffers plain
  // text per user and only calls handleInbound once no new message has arrived for
  // whatsappDebounceMs, combining whatever came in as one logical turn. Scoped to this
  // closure (not module-level like the guards above) because it holds live references to
  // `manager` — safe since createIngestHandler runs once for the process lifetime;
  // baileysClient.js reuses the same handler across reconnects rather than rebuilding it.
  //
  // Deliberately does NOT buffer document/image uploads or button/list taps — those are
  // complete, distinct actions in their own right, not a fragment of a longer thought, and
  // get processed immediately. If one arrives while text is pending for that user, whatever
  // was pending is flushed first so ordering still matches what they actually sent.
  const pendingText = new Map(); // userId -> { texts: string[], user, conversation, timer }

  function flushPendingText(userId) {
    const entry = pendingText.get(userId);
    if (!entry) return Promise.resolve();
    clearTimeout(entry.timer);
    pendingText.delete(userId);
    const combinedText = entry.texts.join("\n");
    return manager.handleInbound(entry.user, entry.conversation, combinedText, null).catch((err) => {
      logger.error({ err, userId }, "Failed handling debounced inbound message");
    });
  }

  function scheduleDebouncedText(user, conversation, text) {
    const entry = pendingText.get(user.id) || { texts: [], user, conversation };
    entry.texts.push(text);
    entry.user = user;
    entry.conversation = conversation;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => flushPendingText(user.id), settings.whatsappDebounceMs);
    pendingText.set(user.id, entry);
  }

  return async function handleIncomingMessage(waId, waMessage) {
    // Checked before the rate limiter on purpose — a redelivered message the user only
    // actually sent once shouldn't burn any of their real inbound budget.
    if (isDuplicateMessage(waMessage.key?.id)) {
      logger.info({ waId, messageId: waMessage.key?.id }, "Duplicate WhatsApp message (already processed) — skipping.");
      return;
    }

    if (!inboundRateLimiter.consume(waId)) {
      logger.warn({ waId }, "Inbound WhatsApp rate limit hit — dropping message without processing.");
      return;
    }

    const content = waMessage.message;
    if (!content) return;

    const user = await getOrCreateUser(waId);
    const conversation = await getOrCreateOpenConversation(user);

    const media = extractMedia(content);
    const text = media ? `[uploaded ${media.filename}]` : extractInboundText(content).text;

    // Logged as its own row regardless of debouncing below — conversation history should
    // reflect exactly what was sent and when, even though the bot may react to several of
    // these as one combined turn.
    await Message.create({
      conversation_id: conversation.id,
      direction: "inbound",
      sender: "user",
      text,
      raw_payload: { key: waMessage.key, messageType: Object.keys(content)[0] },
    });

    if (media) {
      await flushPendingText(user.id);
      const bytes = await whatsappClient.downloadMedia(waMessage);
      await manager.handleDocumentUpload(user, conversation, {
        content: bytes,
        mimeType: media.mimeType,
        filename: media.filename,
        whatsappMediaId: waMessage.key.id,
      });
      return;
    }

    const { interactiveId } = extractInboundText(content);
    if (interactiveId) {
      await flushPendingText(user.id);
      await manager.handleInbound(user, conversation, text, interactiveId);
      return;
    }

    scheduleDebouncedText(user, conversation, text);
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
