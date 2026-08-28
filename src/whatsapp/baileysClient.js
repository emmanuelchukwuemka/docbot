// Thin wrapper around Baileys (WhatsApp Web multi-device protocol).
//
// Unlike the Meta WhatsApp Cloud API this replaces, there is no access token/phone number
// ID/webhook to configure — this process pairs directly with a WhatsApp account by QR code
// (printed to the terminal on first run) and holds a persistent WebSocket connection.
// Session credentials are cached under BAILEYS_AUTH_DIR so restarts don't require
// re-scanning the QR code.
//
// This is an unofficial client, not Meta's Business API — it carries WhatsApp ToS risk
// (account ban) that the Cloud API doesn't. Interactive buttons/lists are sent using
// Baileys' native message types but are not guaranteed to render on every WhatsApp client
// version; sendButtonOptions/sendListOptions fall back to a plain numbered text message if
// the interactive send fails, so the bot never goes silent.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  WAMessageStatus,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { settings } from "../config.js";
import { logger } from "../logger.js";
import { SendQueue } from "./sendQueue.js";
import { RateLimiter } from "../security/rateLimiter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_PICTURE_PATH = path.join(__dirname, "..", "public", "brand", "logo-whatsapp.png");

export const connectionState = {
  status: "disconnected", // disconnected | connecting | qr_pending | open | wrong_account
  // Raw QR payload string for whichever pairing attempt is currently in flight — the admin
  // dashboard renders this as a scannable image (see admin/uiRoutes.js). Null whenever there's
  // no pairing in progress; Baileys replaces it every ~20-60s until scanned or connected.
  qr: null,
};

function toJid(whatsappNumber) {
  return whatsappNumber.includes("@") ? whatsappNumber : `${whatsappNumber}@s.whatsapp.net`;
}

// WhatsApp doesn't always identify a sender by their phone number — when the sender has
// phone-number privacy enabled, inbound messages arrive addressed from a `@lid` (linked ID)
// JID instead of the usual `@s.whatsapp.net` one. Stripping the domain and always replying
// to `<number>@s.whatsapp.net` sends into a JID that doesn't correspond to any real, reachable
// account for those senders — the bot "replies" (no error, message logged) but nothing is
// ever delivered. Keeping the original domain here, and only defaulting it in toJid() when
// none is present, means a reply always goes back out on the same JID the message came in on.
export function jidToWhatsappNumber(jid) {
  const [userPart, domain] = jid.split("@");
  const number = userPart.split(":")[0];
  return domain ? `${number}@${domain}` : number;
}

export class WhatsAppClient {
  constructor() {
    this.sock = null;
    // Every outbound send (replies + the scheduler's bulk reminders) goes through this one
    // queue so message pacing is enforced in exactly one place — see sendQueue.js.
    this.sendQueue = new SendQueue();
    // Per-recipient volume cap, on top of the queue's pacing — see config.js for why a bug
    // or loop hammering one number is worth guarding against separately from send pacing.
    this.outboundLimiter = new RateLimiter({
      max: settings.whatsappOutboundRateLimitMax,
      windowMs: settings.whatsappOutboundRateLimitWindowMs,
    });
    this.profilePictureSynced = false;
    this.numberMismatch = false;
    this.relinking = false;
    // Counts consecutive failed connection attempts so reconnects back off exponentially
    // instead of retrying immediately forever — a sustained rejection (e.g. a 403) with no
    // backoff turns into a tight loop hammering WhatsApp's servers every few seconds, which
    // is itself a pattern that gets an unofficial client flagged/banned (see the 2026-08-21
    // incident this was written in response to). Reset to 0 on a successful "open".
    this.reconnectAttempts = 0;
  }

  /** Starts the Baileys socket and wires `onMessage(waId, message)` for every inbound,
   * non-self, 1:1 chat message. Returns the socket once the connection layer is wired
   * (does not wait for `open` — reconnects happen automatically in the background).
   *
   * `onDeliveryError(waMessageId, errorCode)` fires when WhatsApp accepted one of our
   * outbound sends but then rejected actually delivering it — sendMessage() itself already
   * resolved successfully by that point (that's the ack, arriving asynchronously later), so
   * without this callback a rejected send looks identical to a delivered one everywhere else
   * in the app. */
  async start(onMessage, onDeliveryError) {
    // Kept so relink() can restart the connection later without the caller having to pass
    // these callbacks in again.
    this._onMessage = onMessage;
    this._onDeliveryError = onDeliveryError;

    const { state, saveCreds } = await useMultiFileAuthState(settings.baileysAuthDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: logger.child({ module: "baileys" }).child({}),
      printQRInTerminal: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        connectionState.status = "qr_pending";
        connectionState.qr = qr;
        logger.info(`Scan this QR code with WhatsApp (Linked Devices) to connect ${settings.botName}:`);
        qrcode.generate(qr, { small: true });
      }
      if (connection === "open") {
        connectionState.qr = null;
        if (settings.botPhoneNumber) {
          const connectedNumber = (sock.user?.id || "").split(/[:@]/)[0].replace(/\D/g, "");
          if (connectedNumber !== settings.botPhoneNumber) {
            logger.error(
              { expected: settings.botPhoneNumber, connected: connectedNumber },
              "WhatsApp is linked to an unexpected number — refusing to run. Set BOT_PHONE_NUMBER " +
                "to match, or delete BAILEYS_AUTH_DIR and re-scan the QR code with the right account."
            );
            connectionState.status = "wrong_account";
            this.numberMismatch = true;
            sock.end(new Error("Linked WhatsApp account does not match BOT_PHONE_NUMBER"));
            return;
          }
        }
        connectionState.status = "open";
        this.reconnectAttempts = 0;
        logger.info("WhatsApp connection open.");
        this.syncProfilePicture().catch((err) => logger.warn({ err }, "Failed to sync WhatsApp profile"));
      } else if (connection === "close") {
        if (this.relinking) return; // relink() itself starts the fresh session — don't race it here
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const shouldReconnect = !this.numberMismatch && statusCode !== DisconnectReason.loggedOut;
        logger.warn({ statusCode }, "WhatsApp connection closed.");
        if (shouldReconnect) {
          connectionState.status = "disconnected";
          this.reconnectAttempts += 1;
          const delayMs = Math.min(2000 * 2 ** (this.reconnectAttempts - 1), 5 * 60 * 1000);
          logger.warn(
            { attempt: this.reconnectAttempts, delayMs },
            "Reconnecting to WhatsApp after a backoff delay (not immediately) to avoid hammering it."
          );
          setTimeout(() => this.start(onMessage, onDeliveryError), delayMs);
        } else if (this.numberMismatch) {
          connectionState.status = "wrong_account";
          logger.error("Not reconnecting: linked WhatsApp account does not match BOT_PHONE_NUMBER.");
        } else {
          connectionState.status = "disconnected";
          logger.error("Logged out of WhatsApp — delete BAILEYS_AUTH_DIR and re-scan the QR code to reconnect.");
        }
      } else if (connection === "connecting") {
        connectionState.status = "connecting";
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        if (msg.key.remoteJid?.endsWith("@g.us") || msg.key.remoteJid === "status@broadcast") continue;
        try {
          await onMessage(jidToWhatsappNumber(msg.key.remoteJid), msg);
        } catch (err) {
          logger.error({ err }, "Failed handling inbound WhatsApp message");
        }
      }
    });

    if (onDeliveryError) {
      sock.ev.on("messages.update", (updates) => {
        for (const { key, update } of updates) {
          if (!key.fromMe || update.status !== WAMessageStatus.ERROR) continue;
          const errorCode = update.messageStubParameters?.[0];
          Promise.resolve(onDeliveryError(key.id, errorCode)).catch((err) =>
            logger.error({ err }, "Failed recording WhatsApp delivery error")
          );
        }
      });
    }

    return sock;
  }

  /** Returns false (and logs) if `to` has already received outboundLimiter's cap of
   * messages within the window — callers must skip the send entirely, not queue it for
   * later, so a stuck sender can't build up an unbounded backlog. */
  _checkOutboundLimit(to) {
    if (this.outboundLimiter.consume(to)) return true;
    logger.warn({ to }, "Outbound WhatsApp rate limit hit for this recipient — skipping send.");
    return false;
  }

  async sendText(to, body) {
    if (!this.sock) {
      logger.info({ to }, "WhatsApp not connected — skipping send.");
      return { skipped: true };
    }
    if (!this._checkOutboundLimit(to)) return { skipped: true, reason: "rate_limited" };
    return this.sendQueue.enqueue(() => this.sock.sendMessage(toJid(to), { text: body }));
  }

  /** Interactive reply buttons. WhatsApp allows a max of 3 buttons — for longer menus use
   * sendListOptions instead. `body` is expected to already spell the options out as numbered
   * text (see conversation/manager.js's _send) since native buttons aren't guaranteed to
   * render on every client — so on send failure, falling back to plain `body` text (not a
   * second, separate queued send — still only one logical outbound message) is already
   * self-sufficient, no re-appending needed. */
  async sendButtonOptions(to, body, options) {
    if (!this.sock) {
      logger.info({ to }, "WhatsApp not connected — skipping send.");
      return { skipped: true };
    }
    if (!this._checkOutboundLimit(to)) return { skipped: true, reason: "rate_limited" };
    return this.sendQueue.enqueue(async () => {
      try {
        return await this.sock.sendMessage(toJid(to), {
          text: body,
          footer: settings.botName,
          buttons: options.slice(0, 3).map((option, i) => ({
            buttonId: `opt_${i}`,
            buttonText: { displayText: option.slice(0, 20) },
            type: 1,
          })),
          headerType: 1,
        });
      } catch (err) {
        logger.warn({ err }, "Interactive buttons send failed — falling back to plain text");
        return this.sock.sendMessage(toJid(to), { text: body });
      }
    });
  }

  async sendListOptions(to, body, buttonText, options) {
    if (!this.sock) {
      logger.info({ to }, "WhatsApp not connected — skipping send.");
      return { skipped: true };
    }
    if (!this._checkOutboundLimit(to)) return { skipped: true, reason: "rate_limited" };
    return this.sendQueue.enqueue(async () => {
      try {
        return await this.sock.sendMessage(toJid(to), {
          text: body,
          footer: settings.botName,
          title: "",
          buttonText: buttonText,
          sections: [
            {
              title: "Options",
              rows: options.slice(0, 10).map((option, i) => ({
                title: option.slice(0, 24),
                rowId: `opt_${i}`,
              })),
            },
          ],
        });
      } catch (err) {
        logger.warn({ err }, "Interactive list send failed — falling back to plain text");
        return this.sock.sendMessage(toJid(to), { text: body });
      }
    });
  }

  /** Sets the bot's own WhatsApp display name and profile photo. Runs once per process (not
   * on every reconnect) — cosmetic, so a failure here just logs and moves on. */
  async syncProfilePicture() {
    if (this.profilePictureSynced || !this.sock?.user) return;
    this.profilePictureSynced = true;
    try {
      await this.sock.updateProfileName(settings.botName);
      logger.info(`WhatsApp display name updated to ${settings.botName}.`);
    } catch (err) {
      logger.warn({ err }, "Failed to update WhatsApp display name");
    }
    try {
      await this.sock.updateProfilePicture(this.sock.user.id, { url: PROFILE_PICTURE_PATH });
      logger.info("WhatsApp profile picture updated.");
    } catch (err) {
      logger.warn({ err }, "Failed to update WhatsApp profile picture");
    }
  }

  /** Admin-triggered re-pairing (see admin/uiRoutes.js) — drops the current session and
   * generates a fresh QR code, for switching which device/app a number is linked through
   * without needing shell access. Clears BAILEYS_AUTH_DIR, so the old session is gone for
   * good once this runs; callers should confirm with the operator before invoking it. */
  async relink() {
    this.relinking = true;
    if (this.sock) {
      try {
        this.sock.end(new Error("Manual relink requested"));
      } catch (err) {
        logger.warn({ err }, "Error ending previous WhatsApp socket during relink");
      }
    }
    await rm(settings.baileysAuthDir, { recursive: true, force: true });
    this.numberMismatch = false;
    this.profilePictureSynced = false;
    this.reconnectAttempts = 0;
    connectionState.qr = null;
    connectionState.status = "connecting";
    this.relinking = false;
    await this.start(this._onMessage, this._onDeliveryError);
  }

  /** FR-08 document upload. Returns null (and logs) if the download fails — callers must
   * handle that gracefully, not throw. */
  async downloadMedia(msg) {
    try {
      return await downloadMediaMessage(msg, "buffer", {});
    } catch (err) {
      logger.error({ err }, "Failed to download WhatsApp media");
      return null;
    }
  }
}

// One socket per process — server.js starts it, and the admin dashboard (for staff
// take-over replies) reuses this same instance rather than opening a second connection.
export const whatsappClient = new WhatsAppClient();
