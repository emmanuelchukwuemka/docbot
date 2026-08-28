// Paystack payment webhook — the other half of ConversationManager's NAVIGATE self-serve
// checkout (see conversation/manager.js's _sendNavigatePaymentLink) and of the admin-issued
// custom RELOCATE links (see admin/service.js).
//
// Must be mounted in server.js BEFORE the global express.json() middleware: Paystack signs
// the raw request body, so this route needs express.raw() to see the exact bytes rather than
// an already-parsed/re-serialized object.

import express from "express";
import { Payment } from "../db/models.js";
import { logger } from "../logger.js";
import { verifyTransaction, verifyWebhookSignature } from "./paystackClient.js";

export function createPaymentsWebhookRouter({ conversationManager }) {
  const router = express.Router();

  router.post("/paystack", express.raw({ type: "application/json" }), async (req, res) => {
    const signature = req.headers["x-paystack-signature"];
    if (!verifyWebhookSignature(req.body, signature)) {
      logger.warn("Rejected Paystack webhook with invalid signature");
      return res.status(401).json({ status: "invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch (err) {
      return res.status(400).json({ status: "invalid json" });
    }

    // Ack everything else (transfer events, etc.) without processing — only a completed
    // charge should ever unlock a package.
    if (event.event !== "charge.success") {
      return res.status(200).json({ received: true });
    }

    try {
      const reference = event.data?.reference;
      const verified = await verifyTransaction(reference);
      if (verified.status !== "success") {
        return res.status(200).json({ received: true });
      }

      const payment = await Payment.findOne({ where: { reference } });
      if (!payment || payment.status === "paid") {
        // Unknown reference (not one we issued) or already processed (Paystack retries
        // webhooks) — either way there's nothing left to do.
        return res.status(200).json({ received: true });
      }

      payment.status = "paid";
      payment.paid_at = new Date();
      await payment.save();

      await conversationManager.handlePaymentConfirmed(payment);

      return res.status(200).json({ received: true });
    } catch (err) {
      logger.error({ err }, "Failed processing Paystack webhook");
      // Non-2xx so Paystack retries — the payment isn't marked paid, so this is safe to retry.
      return res.status(500).json({ status: "error" });
    }
  });

  return router;
}
