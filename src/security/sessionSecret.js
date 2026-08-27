import crypto from "node:crypto";
import { settings } from "../config.js";
import { logger } from "../logger.js";

const DEV_SECRET_SEED = "migratech-insecure-dev-only-session-secret-do-not-use-in-production";

export function getSessionSecret() {
  if (settings.sessionSecretKey) {
    return settings.sessionSecretKey;
  }
  logger.warn(
    "SESSION_SECRET_KEY not set — using a deterministic dev-only session secret. " +
      "Set a real one before deploying (anyone with it can forge admin sessions)."
  );
  return crypto.createHash("sha256").update(DEV_SECRET_SEED).digest("hex");
}
