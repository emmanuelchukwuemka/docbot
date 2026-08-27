# MigraTech — WhatsApp Migration Concierge Bot

A WhatsApp-based migration guidance and lead-qualification platform for MigraTech, built
against `PRD MIGRA 1.0`. Node.js + Baileys implementation (ported from an earlier Python
prototype).

## ⚠️ Before this touches a real user

The knowledge base seeded in `src/knowledgeBase/seedData.js` (countries, pathways, FAQs) is
**development sample data**, not verified immigration fact. Every row is stored with
`is_verified_content=false` and no source/verification date. A MigraTech migration
specialist must review and correct this content through the admin dashboard's
knowledge-base editor, attach a real source URL and verification date, and flip
`is_verified_content=true` before it's used to answer a real user.

## ⚠️ About the WhatsApp integration (Baileys)

This bot connects to WhatsApp via **[Baileys](https://github.com/WhiskeySockets/Baileys)**,
an unofficial library that speaks WhatsApp's multi-device Web protocol. That is a different
model from Meta's official WhatsApp Business Cloud API:

- **Pairing**: no access token / phone number ID / app review — you scan a QR code
  (printed to the terminal on first run) from **WhatsApp > Settings > Linked Devices**.
- **Session**: a persistent WebSocket connection held by this process, with credentials
  cached on disk under `BAILEYS_AUTH_DIR` so restarts don't require re-scanning.
- **Risk**: this is not Meta's Business API. Using an unofficial client carries a real risk
  of the WhatsApp account being banned/rate-limited, and interactive buttons/lists are not
  guaranteed to render on every WhatsApp client version (the bot falls back to a plain
  numbered text message if an interactive send fails). Use a dedicated number you're
  prepared to lose, not a primary personal/business number, until you've validated this in
  practice.

## Architecture

```
WhatsApp (Baileys socket) → message ingest → ConversationManager (state machine)
                                                 ├─ AI layer (Claude: NLU + grounded FAQ answers + guardrails)
                                                 ├─ Knowledge base (countries/pathways/FAQs, admin-editable)
                                                 ├─ Eligibility engine (rules over KB pathway criteria)
                                                 ├─ Lead scoring + Application lifecycle tracking
                                                 ├─ Consultation booking (FR-12)
                                                 ├─ Document upload → encrypted local storage (FR-08)
                                                 └─ Escalation / human handoff
                                             Scheduler (node-cron): document reminders,
                                             staff consultation reminders, data retention
                                             Admin dashboard (RBAC, Express + EJS)
```

Language/stack: Node.js (Express, Sequelize, Baileys, `@anthropic-ai/sdk`). Database is
**MySQL**.

**Deliberate MVP simplifications** (carried over from the original design, documented
inline in code where they matter):
- FAQ/pathway retrieval uses keyword scoring, not vector embeddings (`src/knowledgeBase/service.js`).
- The "CRM" is our own `leads` table + admin dashboard, not HubSpot/Zoho.
- Consultation booking (FR-12) captures a free-text preferred time and notifies staff — no
  real calendar (Google Calendar/Calendly) integration.
- The reminder scheduler (FR-13) runs in-process via node-cron — fine for one instance, not
  safe for multiple replicas (jobs would fire once per replica).
- Document storage (FR-08) is local disk, AES-256-GCM-encrypted at rest — not S3/GCS.
- Admin dashboard is server-rendered (EJS), not a separate SPA.

## Local setup

```bash
npm install

cp .env.example .env
# Point DATABASE_URL at a running MySQL instance (or use docker-compose, see below)

npm run seed              # creates tables + loads sample knowledge base
npm start                 # scan the printed QR code with WhatsApp on first run
```

Or with Docker (spins up MySQL for you):

```bash
docker compose up --build
docker compose logs -f app   # watch for the QR code on first run
```

On first startup, the app auto-seeds one admin account from `ADMIN_USERNAME`/
`ADMIN_PASSWORD` in `.env` (role `admin`). Add more staff accounts with:
```bash
node scripts/createAdminUser.js <username> <password> --role admin|agent
```

Health check: `GET /health` reports the Baileys connection status and whether AI
credentials are configured. Without an `ANTHROPIC_API_KEY`, the app still runs — the AI
layer falls back to a deterministic rule-based extractor (see `src/ai/llmClient.js`).

### Wiring up WhatsApp

1. Set `BAILEYS_AUTH_DIR` in `.env` (defaults to `./storage/baileys-auth`).
2. Run `npm start`. A QR code is printed to the terminal.
3. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → scan the code.
4. The bot now receives/sends messages as that WhatsApp account. To unlink, delete
   `BAILEYS_AUTH_DIR` and re-scan.

### Wiring up AI

Set `ANTHROPIC_API_KEY` in `.env`. `ANTHROPIC_MODEL` defaults to `claude-sonnet-5`.
`AI_CONFIDENCE_THRESHOLD` (default `0.6`) controls when the bot says "let me connect you
with a specialist" instead of answering.

### Document encryption

Set `FIELD_ENCRYPTION_KEY` in `.env` to a real 32-byte base64 key before storing real user
documents:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```
If unset, a deterministic dev-only key is used and a warning is logged every time.

### Admin dashboard

`GET /admin/login` — session-cookie auth against DB-backed staff accounts. Two roles:
`agent` (leads, conversations, documents, consultations, tasks) and `admin` (also
knowledge-base editing and staff-account management). Sections: Overview, Leads,
Conversations, Documents, Consultations, Knowledge base, Users, Applications, Tasks, Staff,
Audit log, Settings. The same JSON API exists under `/admin/api/*`, secured by the same
session cookie:

| Area | Endpoints |
|---|---|
| Overview/analytics | `GET /overview`, `/dashboard-charts` |
| Leads | `GET/PATCH /leads`, `/leads/:id` |
| Conversations | `GET /conversations`, `/conversations/:id`, `POST /conversations/:id/resolve` |
| Documents (FR-08) | `GET /documents`, `PATCH /documents/:id` (verify/reject) |
| Consultations (FR-12) | `GET/PATCH /consultations` |
| Knowledge base | `GET/POST/PATCH/DELETE /knowledge/countries`, `/knowledge/pathways`, `/knowledge/faqs` (admin role) |
| Staff accounts | `GET/POST /staff` (admin role) |
| Audit log | `GET /audit-log` (admin role) |
| Data deletion | `DELETE /users/:id` (admin role) |

### Notifications & data retention

The in-process scheduler (`ENABLE_SCHEDULER=true`, default) runs: missing-document
reminders to users (every 6h), overdue-consultation reminders to staff (hourly, needs
`STAFF_NOTIFICATION_WEBHOOK_URL` set), and a data-retention cleanup (daily, **off by
default** — set `ENABLE_DATA_RETENTION_JOB=true` only after MigraTech signs off on an
actual retention policy).

Users can also self-service delete their data anytime by messaging **"delete my data"**
then confirming with **"CONFIRM DELETE"**.

## Tests

```bash
npm test
```

Runs entirely offline (pure business-logic unit tests — eligibility engine, lead scoring,
document checklist, AI guardrails, escalation detection, conversation flows — no MySQL or
WhatsApp/Anthropic credentials needed).

## What's NOT built yet

- Payments, application-submission workflow, job/university matching
- Real calendar integration for consultation booking
- Real cloud object storage for documents (local encrypted storage works today)
- Real CRM integration beyond the built-in leads table
- Multilingual support beyond English
- Vector-embedding RAG — currently keyword-scored retrieval
