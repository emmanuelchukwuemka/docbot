// Web portal payment routes — the dashboard's "Pay Now" button for the self-serve Migra
// Plan tier, plus the browser-redirect callback after Paystack checkout. Separate from
// webhookRoutes.js (Paystack's own server-to-server webhook, which still runs independently
// and is idempotent against this) — this file handles the *user's browser* round-trip, and
// is actually the more reliable confirmation path for a website-initiated payment
// specifically, since it doesn't depend on Paystack's servers being able to reach ours over
// HTTP the way the webhook does (see the still-open SSL/migra.ng gap).
//
// Migra Go isn't sold here — it has no fixed price (a specialist quotes it per pathway), so
// self-serve checkout doesn't apply; that stays a staff-issued link from the admin
// dashboard, same as today.

import { Router } from "express";
import { randomUUID } from "node:crypto";
import { settings } from "../config.js";
import { logger } from "../logger.js";
import { Payment } from "../db/models.js";
import { hasPaidTier } from "./tierAccess.js";
import { initializeTransaction, verifyTransaction } from "./paystackClient.js";
import { requireLogin } from "../portal/deps.js";

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function toDashboard(msg, error) {
  const params = [];
  if (msg) params.push("msg=" + encodeURIComponent(msg));
  if (error) params.push("error=" + encodeURIComponent(error));
  return "/dashboard" + (params.length ? "?" + params.join("&") : "") + "#payments";
}

export function createPortalPaymentsRouter({ conversationManager }) {
  const router = Router();

  router.post(
    "/payments/navigate",
    wrap(requireLogin),
    wrap(async (req, res) => {
      const user = req.portalUser;

      if (await hasPaidTier(user.id, "navigate")) {
        return res.redirect(303, toDashboard("You already have Migra Plan unlocked."));
      }
      if (!settings.paystackConfigured) {
        return res.redirect(303, toDashboard(null, "Payments aren't available right now — please try again shortly."));
      }
      if (!user.email) {
        return res.redirect(303, "/settings?profileError=" + encodeURIComponent("Add an email address first — it's needed for your payment receipt."));
      }

      const reference = `navigate-${randomUUID()}`;
      await Payment.create({
        user_id: user.id,
        amount: settings.navigatePriceNgn,
        currency: "NGN",
        purpose: "Migra Plan — human specialist consultation",
        status: "pending",
        tier: "navigate",
        provider: "paystack",
        reference,
      });

      try {
        const { authorization_url } = await initializeTransaction({
          email: user.email,
          amountNaira: settings.navigatePriceNgn,
          reference,
          metadata: { user_id: user.id, tier: "navigate" },
          callbackUrl: `${req.protocol}://${req.get("host")}/payments/callback`,
        });
        res.redirect(303, authorization_url);
      } catch (err) {
        logger.error({ err, userId: user.id }, "Failed to initialize Paystack transaction from portal");
        res.redirect(303, toDashboard(null, "Couldn't start checkout — please try again."));
      }
    })
  );

  router.get(
    "/payments/callback",
    wrap(async (req, res) => {
      const reference = req.query.reference;
      if (!reference) return res.redirect(303, "/dashboard#payments");

      const payment = await Payment.findOne({ where: { reference } });
      if (!payment) return res.redirect(303, toDashboard(null, "We couldn't find that payment."));

      // Already confirmed — most likely the webhook beat the browser back here. Idempotent
      // either way, same check the webhook itself makes.
      if (payment.status === "paid") {
        return res.redirect(303, toDashboard(`Payment confirmed — reference ${reference}.`));
      }

      try {
        // Re-verifies against Paystack's own API rather than trusting the redirect alone —
        // same reasoning as the webhook handler: a query param is not proof of payment.
        const verified = await verifyTransaction(reference);
        if (verified.status === "success") {
          payment.status = "paid";
          payment.paid_at = new Date();
          await payment.save();
          await conversationManager.handlePaymentConfirmed(payment);
          return res.redirect(303, toDashboard(`Payment confirmed — reference ${reference}.`));
        }
        return res.redirect(303, toDashboard(null, "Payment wasn't completed — you can try again below."));
      } catch (err) {
        logger.error({ err, reference }, "Failed verifying Paystack transaction on portal callback");
        // Genuinely unknown state — don't claim success or failure. The webhook (if it's
        // reachable) or a page refresh can still resolve this once verify succeeds.
        return res.redirect(303, toDashboard(null, "We're still confirming your payment — check back in a moment, or contact support with your reference: " + reference));
      }
    })
  );

  router.use((err, req, res, next) => {
    logger.error({ err }, "Unhandled error in portal payments route");
    if (res.headersSent) return next(err);
    res.redirect(303, toDashboard(null, "Something went wrong with your payment — please try again."));
  });

  return router;
}
