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

  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  aiConfidenceThreshold: num(process.env.AI_CONFIDENCE_THRESHOLD, 0.6),
  // Global cap on OpenAI calls (entity extraction + grounded FAQ answers share one budget) —
  // bounds worst-case cost and stays clear of OpenAI's own per-minute rate limits regardless
  // of how many conversations are active at once. Calls beyond the cap fall back to the same
  // rule-based/raw-snippet paths used when no API key is configured at all.
  aiRateLimitMax: num(process.env.AI_RATE_LIMIT_MAX, 30),
  aiRateLimitWindowMs: num(process.env.AI_RATE_LIMIT_WINDOW_MS, 60_000),

  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "change-me",
  sessionSecretKey: process.env.SESSION_SECRET_KEY || "",

  staffNotificationWebhookUrl: process.env.STAFF_NOTIFICATION_WEBHOOK_URL || "",

  fieldEncryptionKey: process.env.FIELD_ENCRYPTION_KEY || "",
  documentStorageDir: process.env.DOCUMENT_STORAGE_DIR || "./storage/documents",
  // Publicly-servable (unlike documentStorageDir above, which is encrypted and never served
  // directly) — but still needs its own persistent volume, same as documentStorageDir:
  // src/public/ is baked into the Docker image at build time and gets replaced on every
  // deploy, so anything written there at runtime (an uploaded photo) would be silently wiped
  // on the next deploy. See server.js for the dedicated static route that serves this path.
  vendorPhotoStorageDir: process.env.VENDOR_PHOTO_STORAGE_DIR || "./storage/vendor-photos",

  dataRetentionDays: num(process.env.DATA_RETENTION_DAYS, 365),
  enableDataRetentionJob: bool(process.env.ENABLE_DATA_RETENTION_JOB, false),

  // Reminder jobs (scheduler.js) are bot-initiated, not replies to something the user just
  // said — structurally the same shape as a "bulk campaign," one of the more commonly cited
  // WhatsApp-flagging patterns. Two mitigations: cap how many go out in one cron run (a
  // large backlog spreads across multiple scheduled runs instead of one burst), and add
  // deliberate extra spacing between each send on top of SendQueue's baseline pacing.
  reminderBatchMaxPerRun: num(process.env.REMINDER_BATCH_MAX_PER_RUN, 15),
  reminderInterSendMinMs: num(process.env.REMINDER_INTER_SEND_MIN_MS, 5000),
  reminderInterSendJitterMs: num(process.env.REMINDER_INTER_SEND_JITTER_MS, 10000),

  enableScheduler: bool(process.env.ENABLE_SCHEDULER, true),

  baileysAuthDir: process.env.BAILEYS_AUTH_DIR || "./storage/baileys-auth",
  whatsappMinSendIntervalMs: num(process.env.WHATSAPP_MIN_SEND_INTERVAL_MS, 1200),
  // Per-sender cap on inbound messages we'll actually process — protects against a single
  // flooding number (bug, retry storm, or deliberate abuse) running up AI cost and driving
  // a burst of outbound replies, which is exactly the pattern that gets an unofficial
  // WhatsApp client flagged. Messages beyond the cap are dropped, not queued.
  whatsappInboundRateLimitMax: num(process.env.WHATSAPP_INBOUND_RATE_LIMIT_MAX, 10),
  whatsappInboundRateLimitWindowMs: num(process.env.WHATSAPP_INBOUND_RATE_LIMIT_WINDOW_MS, 60_000),
  // How long ingest.js waits after a plain-text message before actually processing it, to
  // see if more is coming (someone typing a thought across 2-3 quick bubbles) — see
  // ingest.js's scheduleDebouncedText for the full reasoning. Doesn't apply to document/
  // image uploads or button/list taps, which are always handled immediately.
  whatsappDebounceMs: num(process.env.WHATSAPP_DEBOUNCE_MS, 1800),
  // Per-recipient cap on outbound sends — a ceiling independent of WHATSAPP_MIN_SEND_INTERVAL_MS
  // (which paces gaps between sends but not total volume). Stops any bug/loop from hammering
  // one number, which is a known trigger for WhatsApp banning an unofficial client.
  whatsappOutboundRateLimitMax: num(process.env.WHATSAPP_OUTBOUND_RATE_LIMIT_MAX, 30),
  whatsappOutboundRateLimitWindowMs: num(process.env.WHATSAPP_OUTBOUND_RATE_LIMIT_WINDOW_MS, 3_600_000),
  // Account-wide cap, independent of the per-recipient one above — that limiter only stops
  // hammering *one* number; nothing previously stopped a bug/loop (or a large reminder
  // backlog) from sending to hundreds of *different* numbers in the same window, which is
  // its own, arguably worse, ban-risk pattern. 200/hour is generous for normal conversation
  // + reminder volume while still being a real circuit breaker.
  whatsappGlobalOutboundRateLimitMax: num(process.env.WHATSAPP_GLOBAL_OUTBOUND_RATE_LIMIT_MAX, 200),
  whatsappGlobalOutboundRateLimitWindowMs: num(process.env.WHATSAPP_GLOBAL_OUTBOUND_RATE_LIMIT_WINDOW_MS, 3_600_000),
  // Simulated "typing…" delay before each bot reply (real WhatsApp presence indicator, not
  // just a sleep — see whatsapp/baileysClient.js's simulateTyping) — an always-instant,
  // sub-second reply is itself a strong automation signal distinct from the pacing/volume
  // limits above, which govern gaps *between* sends rather than reply latency to a single
  // message. Added 2026-08-30 after an account got WhatsApp-restricted for 24h, plausibly
  // (in part) for exactly this. Deliberately NOT gated on ENVIRONMENT — production's
  // docker-compose.yml hardcodes ENVIRONMENT=development (see
  // migratech_production_server memory), so anything gated that way would silently never
  // run where it matters.
  whatsappTypingDelayEnabled: bool(process.env.WHATSAPP_TYPING_DELAY_ENABLED, true),
  whatsappTypingDelayMinMs: num(process.env.WHATSAPP_TYPING_DELAY_MIN_MS, 2500),
  whatsappTypingDelayJitterMs: num(process.env.WHATSAPP_TYPING_DELAY_JITTER_MS, 3000),
  whatsappTypingDelayMsPerChar: num(process.env.WHATSAPP_TYPING_DELAY_MS_PER_CHAR, 15),
  whatsappTypingDelayMaxBonusMs: num(process.env.WHATSAPP_TYPING_DELAY_MAX_BONUS_MS, 6500),
  // Safety check, not a way to "set" the bot's number — Baileys has no concept of configuring
  // which account to use; the number is whatever WhatsApp account the QR code was scanned
  // with. If set, the bot refuses to run against a linked session that doesn't match, so an
  // accidental scan with the wrong phone can't silently start sending messages as that account.
  botPhoneNumber: (process.env.BOT_PHONE_NUMBER || "").replace(/\D/g, ""),
  // WhatsApp display name + message footer branding. Doesn't touch the welcome/menu/legal
  // copy in conversation/manager.js — that's business content, not just a name.
  botName: process.env.BOT_NAME || "MigraTech",

  // --- WhatsApp Cloud API webhook (Meta's official platform, 2026-09-21) — deliberately
  // parallel to, not a replacement for, the Baileys connection above. This only receives and
  // logs webhook events for now; it is NOT wired into ConversationManager. Exists so the Meta
  // App Dashboard's "Verify and save" step (Production setup > Webhooks) has something real
  // to talk to while evaluating a move to the official API. See whatsapp/cloudWebhookRoutes.js.
  whatsappCloudVerifyToken: process.env.WHATSAPP_CLOUD_VERIFY_TOKEN || "",
  // App Secret from Meta App Dashboard > App settings > Basic. Used to verify the
  // X-Hub-Signature-256 header on incoming POSTs actually came from Meta, not a spoofed
  // request hitting this now-public URL. Optional only because it isn't known yet at initial
  // setup — the route logs a loud warning and skips verification if unset; set this before
  // treating any received payload as trustworthy.
  whatsappCloudAppSecret: process.env.WHATSAPP_CLOUD_APP_SECRET || "",

  // --- wsapi.chat webhook (2026-09-21) — see whatsapp/wsapiWebhookRoutes.js's file header
  // for the important context: this is NOT an official WhatsApp API, same risk category as
  // Baileys, evaluated at the user's explicit direction after that tradeoff was flagged.
  // Verify+log only, not wired into ConversationManager.
  wsapiSigningSecret: process.env.WSAPI_SIGNING_SECRET || "",

  port: num(process.env.PORT, 8000),

  // --- Payments (Paystack) — the DISCOVER/NAVIGATE/RELOCATE package model ---
  // NAVIGATE is a fixed "first payment" the bot can sell itself via a self-serve Paystack
  // link. RELOCATE is explicitly variable "depending on the migration pathway and service"
  // (product spec), so it is never auto-priced by the bot — staff issue a custom-amount
  // Paystack link from the admin dashboard instead (see admin/service.js createPayment).
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || "",
  // NAVIGATE is the fixed self-serve price actually charged. The USD figures are display-only
  // (shown as an approximate parenthetical alongside the real NGN charge) — no live FX
  // conversion, just what MigraTech quotes internationally.
  navigatePriceNgn: num(process.env.NAVIGATE_PRICE_NGN, 99_000),
  navigatePriceUsdDisplay: num(process.env.NAVIGATE_PRICE_USD_DISPLAY, 70),
  // RELOCATE has no fixed price — staff issue a custom-amount quote per pathway/service (see
  // admin/service.js createPayment). This is only a "starting around" figure mentioned to set
  // expectations while they wait for their real quote.
  relocateReferencePriceNgn: num(process.env.RELOCATE_REFERENCE_PRICE_NGN, 150_000),
  relocateReferencePriceUsdDisplay: num(process.env.RELOCATE_REFERENCE_PRICE_USD_DISPLAY, 125),

  // --- Partner agents (Vendor) — commission-on-won-case model, 2026-09-01 ---
  // Applies to every vendor unless Vendor.commission_rate_percent overrides it (staff have
  // negotiated a different rate with that specific agent). Actual payout is manual/off
  // -platform — this only drives what admin/service.js's markCaseWon() calculates and logs.
  defaultCommissionRatePercent: num(process.env.DEFAULT_COMMISSION_RATE_PERCENT, 15),

  get paystackConfigured() {
    return Boolean(this.paystackSecretKey);
  },

  get aiConfigured() {
    return Boolean(this.openaiApiKey);
  },
};
