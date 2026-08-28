// Thin wrapper around Paystack's Transactions API — used to sell the NAVIGATE package
// self-serve, and by staff (admin/service.js) to issue custom-amount RELOCATE quotes.
//
// Docs: https://paystack.com/docs/api/transaction/
//
// No card/bank details ever pass through this app — Paystack hosts the actual checkout page
// (`authorization_url`); we only ever see a reference and a success/failure webhook.

import crypto from "node:crypto";
import { settings } from "../config.js";

const BASE_URL = "https://api.paystack.co";

function headers() {
  return {
    Authorization: `Bearer ${settings.paystackSecretKey}`,
    "Content-Type": "application/json",
  };
}

/** Creates a hosted checkout session. Returns { authorization_url, access_code, reference }.
 * `amountNaira` is whole Naira (e.g. 15000 for ₦15,000) — Paystack's API wants kobo. */
export async function initializeTransaction({ email, amountNaira, reference, metadata }) {
  const response = await fetch(`${BASE_URL}/transaction/initialize`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      email,
      amount: Math.round(amountNaira * 100),
      reference,
      metadata,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(`Paystack initialize failed: ${data.message || response.statusText}`);
  }
  return data.data;
}

/** Server-side source of truth for a transaction's real status — called from the webhook
 * handler rather than trusting the webhook payload's own `data` alone, since Paystack's own
 * docs recommend re-verifying before crediting anything. */
export async function verifyTransaction(reference) {
  const response = await fetch(`${BASE_URL}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: headers(),
  });
  const data = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(`Paystack verify failed: ${data.message || response.statusText}`);
  }
  return data.data;
}

/** Paystack signs webhook bodies with HMAC-SHA512 of the raw (unparsed) request body, using
 * the secret key — `rawBody` must be the exact bytes received, not a re-serialized JSON.parse
 * round-trip, or the signature will never match. */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader || !settings.paystackSecretKey) return false;
  const expected = crypto.createHmac("sha512", settings.paystackSecretKey).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signatureHeader);
  // timingSafeEqual throws on mismatched lengths rather than returning false, so a
  // malformed/wrong-length header must be rejected before it ever reaches that call.
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}
