// wsapi.chat webhook receiver — 2026-09-21, user-directed evaluation of wsapi.chat as a
// WhatsApp connection option. IMPORTANT CONTEXT, not just a technical note: wsapi.chat is
// NOT an official WhatsApp API (confirmed via their own FAQ) — it's an independent/unofficial
// automation layer, the same risk category as the Baileys connection already in use
// (whatsapp/baileysClient.js), just third-party-hosted instead of self-hosted. This was
// flagged to the user directly before building this; they chose to proceed anyway. Treat
// this the same as cloudWebhookRoutes.js: verify + log only, NOT wired into
// ConversationManager. Whether to route real traffic through any of these paths (Baileys,
// Meta Cloud API, or this) is a still-open decision, not settled by this file existing.
//
// Must be mounted in server.js BEFORE the global express.json() middleware, same reasoning
// as payments/webhookRoutes.js and whatsapp/cloudWebhookRoutes.js: wsapi.chat signs the raw
// POST body, so this route needs express.raw() to see the exact bytes.

import express from "express";
import crypto from "node:crypto";
import { settings } from "../config.js";
import { logger } from "../logger.js";

// Same HMAC-SHA256 + "sha256=" prefix scheme as whatsapp/cloudWebhookRoutes.js's Meta
// signature check, just a different header name (X-Webhook-Signature vs
// X-Hub-Signature-256) — kept as its own function rather than shared, since the two
// providers' schemes matching today is coincidental, not a guarantee they'll stay identical.
function verifyWsapiSignature(rawBody, signatureHeader, signingSecret) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = crypto.createHmac("sha256", signingSecret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function createWsapiWebhookRouter() {
  const router = express.Router();

  // No GET verification handshake for this provider (unlike Meta's Cloud API) — per their
  // docs, webhook setup is just "configure the URL," so there's only a POST route here.
  router.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
    if (settings.wsapiSigningSecret) {
      const signature = req.headers["x-webhook-signature"];
      if (!verifyWsapiSignature(req.body, signature, settings.wsapiSigningSecret)) {
        logger.warn("Rejected wsapi.chat webhook with invalid/missing signature");
        return res.sendStatus(401);
      }
    } else {
      logger.warn("WSAPI_SIGNING_SECRET not set — accepting this webhook payload without verifying it actually came from wsapi.chat");
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString("utf8"));
    } catch {
      logger.warn("wsapi.chat webhook POST body wasn't valid JSON");
      return res.sendStatus(400);
    }

    // Logged only, not processed — see file header. eventType/eventData shape per their
    // docs: { eventId, instanceId, receivedAt, eventType, eventData }.
    logger.info({ payload }, "Received wsapi.chat webhook event");
    res.sendStatus(200);
  });

  return router;
}
