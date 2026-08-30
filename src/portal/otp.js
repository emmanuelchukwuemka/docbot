// Shared WhatsApp-OTP mechanism for registration verification and password reset — see
// db/models.js's note on why WhatsApp rather than email (no email service is configured
// anywhere in this codebase; WhatsApp is real, already-live infrastructure).

import crypto from "node:crypto";
import { settings } from "../config.js";
import { logger } from "../logger.js";
import { hashPassword, verifyPassword } from "../security/passwords.js";
import { RateLimiter } from "../security/rateLimiter.js";
import { HttpError } from "../admin/httpError.js";
import { whatsappClient } from "../whatsapp/baileysClient.js";

const CODE_TTL_MS = 15 * 60_000;

// Separate from login/register limiters — specifically caps how many WhatsApp messages one
// account can trigger, independent of the outbound rate limiter WhatsAppClient already
// enforces globally (see config.js) — this one exists so a user mashing "resend" can't run
// up against that global cap on its own.
const sendLimiter = new RateLimiter({ max: 5, windowMs: 30 * 60_000 });
const verifyLimiter = new RateLimiter({ max: 8, windowMs: 15 * 60_000 });

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}

/** Generates a code, stores its hash on the user row, and sends it over WhatsApp. Throws if
 * WhatsApp isn't actually connected right now (sendText silently no-ops in that case — see
 * baileysClient.js — and silently pretending a code was sent when it wasn't would leave
 * someone stuck with no way in). */
export async function sendOtp(user, { purpose = "verify" } = {}) {
  if (!sendLimiter.consume(user.id)) {
    throw new HttpError(429, "Too many codes requested — wait a bit before trying again.");
  }

  const code = generateCode();
  user.reset_code_hash = hashPassword(code);
  user.reset_code_expires_at = new Date(Date.now() + CODE_TTL_MS);
  await user.save();

  // Dev-only — never fires in production (settings.environment gate), lets local testing
  // proceed without a live WhatsApp connection. Real codes are never logged.
  if (settings.environment === "development") {
    logger.info({ code, userId: user.id }, "DEV ONLY: OTP code (would be sent via WhatsApp)");
  }

  const verb = purpose === "reset" ? "password reset" : "verification";
  // sendText() doesn't only fail by returning {skipped:true} (no socket at all) — a socket
  // that exists but is mid-disconnect throws instead (found while testing this exact flow
  // against a stale local connection). Either way means "the code wasn't delivered."
  let result;
  try {
    result = await whatsappClient.sendText(
      user.whatsapp_number,
      `Your MigraTech ${verb} code is ${code}. It expires in 15 minutes. Never share this code with anyone.`
    );
  } catch (err) {
    result = { skipped: true };
  }

  if (result?.skipped) {
    throw new HttpError(
      503,
      "We couldn't send your code right now (WhatsApp is temporarily unavailable) — please try again shortly, or contact support."
    );
  }
}

/** Checks `code` against the stored hash and expiry, clearing it either way (a code is
 * single-use whether it succeeds or fails on a given attempt). */
export async function verifyOtp(user, code) {
  if (!verifyLimiter.consume(user.id)) {
    throw new HttpError(429, "Too many attempts — request a new code and try again.");
  }

  const valid =
    user.reset_code_hash &&
    user.reset_code_expires_at &&
    user.reset_code_expires_at > new Date() &&
    verifyPassword((code || "").trim(), user.reset_code_hash);

  user.reset_code_hash = null;
  user.reset_code_expires_at = null;
  await user.save();

  if (!valid) throw new HttpError(400, "That code is invalid or expired — request a new one.");
}
