// WhatsApp Cloud API (Meta's official platform) webhook receiver — 2026-09-21, set up
// while evaluating a move off the unofficial Baileys connection (whatsapp/baileysClient.js)
// onto Meta's sanctioned API. Deliberately parallel, not a replacement: this route only
// verifies Meta's webhook subscription and logs incoming events. It is NOT wired into
// ConversationManager — nothing here routes a Cloud API message into the bot's actual
// conversation logic yet. That's a separate, larger decision (see conversation with the
// user, 2026-09-21) than just standing up the endpoint Meta's dashboard needs to talk to.
//
// Must be mounted in server.js BEFORE the global express.json() middleware, same reasoning
// as payments/webhookRoutes.js: Meta signs the raw POST body (X-Hub-Signature-256), so this
// route needs express.raw() to see the exact bytes rather than an already-parsed/
// re-serialized object.

import express from "express";
import crypto from "node:crypto";
import { settings } from "../config.js";
import { logger } from "../logger.js";

function verifyCloudApiSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  // timingSafeEqual throws on mismatched lengths rather than returning false, so a
  // malformed/wrong-length header must be rejected before it ever reaches that call.
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function createWhatsappCloudWebhookRouter() {
  const router = express.Router();

  // Meta's verification handshake — fired when you click "Verify and save" in the App
  // Dashboard (Production setup > Webhooks), and again any time the subscription is
  // re-verified. Must echo hub.challenge back as plain text, not JSON, or Meta treats
  // verification as failed.
  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!settings.whatsappCloudVerifyToken) {
      logger.warn("WhatsApp Cloud webhook verification attempted but WHATSAPP_CLOUD_VERIFY_TOKEN isn't set on this server");
      return res.sendStatus(403);
    }
    if (mode === "subscribe" && token === settings.whatsappCloudVerifyToken) {
      logger.info("WhatsApp Cloud webhook verified successfully by Meta");
      return res.status(200).send(challenge);
    }
    logger.warn({ mode, tokenMatched: token === settings.whatsappCloudVerifyToken }, "WhatsApp Cloud webhook verification failed");
    return res.sendStatus(403);
  });

  // Real events (messages, delivery statuses, etc.) once the subscription is verified.
  // Always acks 200 quickly regardless of payload content — Meta disables a webhook
  // subscription that repeatedly errors or times out, so this must never throw upstream.
  router.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
    if (settings.whatsappCloudAppSecret) {
      const signature = req.headers["x-hub-signature-256"];
      if (!verifyCloudApiSignature(req.body, signature, settings.whatsappCloudAppSecret)) {
        logger.warn("Rejected WhatsApp Cloud webhook with invalid/missing signature");
        return res.sendStatus(401);
      }
    } else {
      logger.warn("WHATSAPP_CLOUD_APP_SECRET not set — accepting this webhook payload without verifying it actually came from Meta");
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      logger.warn("WhatsApp Cloud webhook POST body wasn't valid JSON");
      return res.sendStatus(400);
    }

    // Logged only, not processed — see file header. Once there's a real decision to route
    // Cloud API traffic through the bot, this is where that would plug in.
    logger.info({ payload }, "Received WhatsApp Cloud API webhook event");
    res.sendStatus(200);
  });

  return router;
}
