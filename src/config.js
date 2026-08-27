import "dotenv/config";

function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function num(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

export const settings = {
  environment: process.env.ENVIRONMENT || "development",
  logLevel: process.env.LOG_LEVEL || "info",

  databaseUrl: process.env.DATABASE_URL || "mysql://migratech:migratech@localhost:3306/migratech",

  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
  aiConfidenceThreshold: num(process.env.AI_CONFIDENCE_THRESHOLD, 0.6),

  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "change-me",
  sessionSecretKey: process.env.SESSION_SECRET_KEY || "",

  staffNotificationWebhookUrl: process.env.STAFF_NOTIFICATION_WEBHOOK_URL || "",

  fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY || "",
  documentStorageDir: process.env.DOCUMENT_STORAGE_DIR || "./storage/documents",

  dataRetentionDays: num(process.env.DATA_RETENTION_DAYS, 365),
  enableDataRetentionJob: bool(process.env.ENABLE_DATA_RETENTION_JOB, false),

  enableScheduler: bool(process.env.ENABLE_SCHEDULER, true),

  baileysAuthDir: process.env.BAILEYS_AUTH_DIR || "./storage/baileys-auth",
  whatsappMinSendIntervalMs: num(process.env.WHATSAPP_MIN_SEND_INTERVAL_MS, 1200),
  // Safety check, not a way to "set" the bot's number — Baileys has no concept of configuring
  // which account to use; the number is whatever WhatsApp account the QR code was scanned
  // with. If set, the bot refuses to run against a linked session that doesn't match, so an
  // accidental scan with the wrong phone can't silently start sending messages as that account.
  botPhoneNumber: (process.env.BOT_PHONE_NUMBER || "").replace(/\D/g, ""),
  // WhatsApp display name + message footer branding. Doesn't touch the welcome/menu/legal
  // copy in conversation/manager.js — that's business content, not just a name.
  botName: process.env.BOT_NAME || "MigraTech",

  port: num(process.env.PORT, 8000),

  get aiConfigured() {
    return Boolean(this.anthropicApiKey);
  },
};
