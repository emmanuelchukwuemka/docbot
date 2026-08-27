// PRD section 36 — "Encryption at rest" for uploaded documents, AES-256-GCM.
//
// Real key management (KMS, secrets manager) is a deployment decision MigraTech needs to
// make, not something to invent here. What this module guarantees: uploaded document bytes
// are never written to disk in plaintext, and the encryption key is read from
// FIELD_ENCRYPTION_KEY (not hardcoded). If that's unset, a deterministic dev-only key is
// derived so local development doesn't crash — explicitly NOT safe for production; a
// warning is logged every time that fallback is used.

import crypto from "node:crypto";
import { settings } from "../config.js";
import { logger } from "../logger.js";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const DEV_KEY_SEED = "migratech-insecure-dev-only-key-do-not-use-in-production";

function deriveDevKey() {
  return crypto.createHash("sha256").update(DEV_KEY_SEED).digest();
}

function getKey() {
  if (settings.fieldEncryptionKey) {
    const key = Buffer.from(settings.fieldEncryptionKey, "base64");
    if (key.length !== 32) {
      throw new Error("FIELD_ENCRYPTION_KEY must decode (base64) to exactly 32 bytes.");
    }
    return key;
  }
  logger.warn(
    "FIELD_ENCRYPTION_KEY not set — using a deterministic dev-only encryption key. " +
      "Set a real key before storing real user documents."
  );
  return deriveDevKey();
}

export function encryptBytes(data) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptBytes(data) {
  const key = getKey();
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = data.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
