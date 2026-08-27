// Server-rendered admin dashboard pages. Mutations reuse the exact same service functions
// as the JSON API (admin/service.js) — a form POST here just calls the same code a JSON
// client would hit, so behavior (including audit logging) never drifts between the two.

import { Router } from "express";
import { Op } from "sequelize";
import QRCode from "qrcode";
import { getSessionAdminUser, SESSION_KEY } from "./deps.js";
import { HttpError } from "./httpError.js";
import * as svc from "./service.js";
import { AdminUser, Conversation, Document, Payment, Task } from "../db/models.js";
import { verifyPassword } from "../security/passwords.js";
import { LocalEncryptedStorage } from "../documents/storage.js";
import { connectionState, whatsappClient } from "../whatsapp/baileysClient.js";
import { logAction } from "./audit.js";

export const router = Router();

function redirect(res, path, msg = null, error = false) {
  if (msg) {
    const sep = path.includes("?") ? "&" : "?";
    path = `${path}${sep}msg=${encodeURIComponent(msg)}&type=${error ? "error" : "success"}`;
  }
  res.redirect(303, path);
}

async function navCounts() {
  return {
    conversations: await Conversation.count({ where: { state: { [Op.notIn]: ["ended", "escalated"] } } }),
    documents: await Document.count({ where: { verification_status: "unreviewed" } }),
    tasks: await Task.count({ where: { status: "pending" } }),
    escalated: await Conversation.count({ where: { escalation_status: "requested" } }),
    payments: await Payment.count({ where: { status: "pending" } }),
  };
}

const TITLES = {
  overview: "Overview",
  leads: "Leads",
  conversations: "Conversations",
  documents: "Documents",
  consultations: "Consultations",
  knowledge: "Knowledge base",
  users: "Users",
  applications: "Applications",
  tasks: "Tasks",
  staff: "Staff",
  whatsapp: "WhatsApp",
  audit_log: "Audit log",
  settings: "Settings",
  search: "Search",
  payments: "Payments",
};

async function render(req, res, template, active, extra = {}) {
  res.render(template, {
    active,
    title: TITLES[active] || active,
    user: req.adminUser,
    nav_counts: await navCounts(),
    flash: req.query.msg ? { message: req.query.msg, type: req.query.type || "success" } : null,
    ...extra,
  });
}

async function requireLogin(req, res, next) {
  const user = await getSessionAdminUser(req);
  if (!user) return res.redirect(303, "/admin/login");
  req.adminUser = user;
  next();
}

function requireAdminRolePage(fallbackPath = "/admin/") {
  return (req, res, next) => {
    if (req.adminUser.role !== "admin") return redirect(res, fallbackPath, "Admin role required for that action.", true);
    next();
  };
}

async function withError(req, res, path, fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HttpError) return redirect(res, path, err.detail, true);
    throw err;
  }
}

// --------------------------------------------------------------------------- //
// Auth
// --------------------------------------------------------------------------- //

router.get("/login", async (req, res) => {
  if (await getSessionAdminUser(req)) return res.redirect(303, "/admin/");
  res.render("login", { error: null });
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const user = await AdminUser.findOne({ where: { username, is_active: true } });
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).render("login", { error: "Invalid username or password" });
  }
  req.session[SESSION_KEY] = user.id;
  res.redirect(303, "/admin/");
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect(303, "/admin/login"));
});

router.use(requireLogin);

// --------------------------------------------------------------------------- //
// Overview
// --------------------------------------------------------------------------- //

router.get("/", async (req, res) => {
  await render(req, res, "overview", "overview", {
    overview: await svc.overview(),
    charts: await svc.dashboardCharts(),
    leads: await svc.listLeads(null),
    recentLeads: await svc.recentLeads(5),
    taskStats: await svc.taskStats(),
    paymentStats: await svc.paymentStats(),
    conversations: await svc.listConversations(false),
    documents: await svc.listDocuments("unreviewed"),
    tasks: await svc.listTasks(null),
  });
});

// --------------------------------------------------------------------------- //
// Search (topbar)
// --------------------------------------------------------------------------- //

router.get("/search", async (req, res) => {
  const q = req.query.q || "";
  await render(req, res, "search", "search", { q, results: await svc.searchUsers(q) });
});

// --------------------------------------------------------------------------- //
// Leads
// --------------------------------------------------------------------------- //

router.get("/leads", async (req, res) => {
  await render(req, res, "leads", "leads", { leads: await svc.listLeads(null) });
});

router.post("/leads/:id/update", async (req, res) => {
  await withError(req, res, "/admin/leads", async () => {
    await svc.updateLead(
      req.params.id,
      { status: req.body.status || null, assigned_agent: req.body.assigned_agent || null },
      req.adminUser.username
    );
    redirect(res, "/admin/leads", "Lead updated.");
  });
});

// --------------------------------------------------------------------------- //
// Conversations
// --------------------------------------------------------------------------- //

router.get("/conversations", async (req, res) => {
  await render(req, res, "conversations", "conversations", {
    conversations: await svc.listConversations(req.query.escalated === "1"),
    escalatedOnly: req.query.escalated === "1",
  });
});

router.get("/conversations/:id", async (req, res) => {
  await withError(req, res, "/admin/conversations", async () => {
    await render(req, res, "conversation_detail", "conversations", {
      conversation: await svc.getConversation(req.params.id),
    });
  });
});

router.post("/conversations/:id/resolve", async (req, res) => {
  await withError(req, res, `/admin/conversations/${req.params.id}`, async () => {
    await svc.resolveConversation(req.params.id, req.adminUser.username, req.adminUser.username);
    redirect(res, `/admin/conversations/${req.params.id}`, "Marked in progress.");
  });
});

router.post("/conversations/:id/send", async (req, res) => {
  await withError(req, res, `/admin/conversations/${req.params.id}`, async () => {
    await svc.sendStaffMessage(req.params.id, req.body.text, req.adminUser.username);
    redirect(res, `/admin/conversations/${req.params.id}`, "Message sent.");
  });
});

router.post("/conversations/:id/return-to-bot", async (req, res) => {
  await withError(req, res, `/admin/conversations/${req.params.id}`, async () => {
    await svc.returnConversationToBot(req.params.id, req.adminUser.username);
    redirect(res, `/admin/conversations/${req.params.id}`, "Handed back to the bot.");
  });
});

// --------------------------------------------------------------------------- //
// Documents
// --------------------------------------------------------------------------- //

router.get("/documents", async (req, res) => {
  await render(req, res, "documents", "documents", { documents: await svc.listDocuments(req.query.status || null) });
});

router.post("/documents/:id/review", async (req, res) => {
  await withError(req, res, "/admin/documents", async () => {
    await svc.reviewDocument(req.params.id, req.body.verification_status, req.adminUser.username);
    redirect(res, "/admin/documents", "Document reviewed.");
  });
});

// Decrypts and streams the uploaded file so staff can actually inspect it before
// verifying/rejecting — any logged-in staff member can view (matches who can review).
router.get("/documents/:id/file", async (req, res) => {
  const document = await Document.findByPk(req.params.id);
  if (!document || !document.file_location) return res.status(404).send("File not found.");

  let bytes;
  try {
    bytes = new LocalEncryptedStorage().read(document.file_location);
  } catch {
    return res.status(500).send("Could not decrypt this file.");
  }

  res.setHeader("Content-Type", document.mime_type || "application/octet-stream");
  const safeName = (document.original_filename || "document").replace(/[^\w.\- ]/g, "_");
  res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
  res.send(bytes);
});

// --------------------------------------------------------------------------- //
// Consultations
// --------------------------------------------------------------------------- //

router.get("/consultations", async (req, res) => {
  await render(req, res, "consultations", "consultations", {
    consultations: await svc.listConsultations(req.query.status || null),
  });
});

router.post("/consultations/:id/update", async (req, res) => {
  await withError(req, res, "/admin/consultations", async () => {
    await svc.updateConsultation(req.params.id, req.body.status, req.adminUser.username);
    redirect(res, "/admin/consultations", "Consultation updated.");
  });
});

// --------------------------------------------------------------------------- //
// Knowledge base
// --------------------------------------------------------------------------- //

router.get("/knowledge", async (req, res) => {
  await render(req, res, "knowledge", "knowledge", {
    countries: await svc.listCountries(),
    pathways: await svc.listPathways(),
    faqs: await svc.listFaqs(),
  });
});

router.post("/knowledge/countries", requireAdminRolePage("/admin/knowledge"), async (req, res) => {
  await withError(req, res, "/admin/knowledge", async () => {
    await svc.createCountry({ name: req.body.name, code: req.body.code }, req.adminUser.username);
    redirect(res, "/admin/knowledge", "Country added.");
  });
});

router.post("/knowledge/pathways", requireAdminRolePage("/admin/knowledge"), async (req, res) => {
  await withError(req, res, "/admin/knowledge", async () => {
    await svc.createPathway(
      {
        country_id: req.body.country_id,
        name: req.body.name,
        category: req.body.category,
        summary: req.body.summary || null,
        documents: (req.body.documents || "").split("\n").map((s) => s.trim()).filter(Boolean),
        requirements: (req.body.requirements || "").split("\n").map((s) => s.trim()).filter(Boolean),
        source_url: req.body.source_url || null,
        is_verified_content: req.body.is_verified_content === "on",
      },
      req.adminUser.username
    );
    redirect(res, "/admin/knowledge", "Pathway added.");
  });
});

router.post("/knowledge/pathways/:id/update", requireAdminRolePage("/admin/knowledge"), async (req, res) => {
  await withError(req, res, "/admin/knowledge", async () => {
    await svc.updatePathway(
      req.params.id,
      {
        country_id: req.body.country_id,
        name: req.body.name,
        category: req.body.category,
        summary: req.body.summary || null,
        documents: (req.body.documents || "").split("\n").map((s) => s.trim()).filter(Boolean),
        requirements: (req.body.requirements || "").split("\n").map((s) => s.trim()).filter(Boolean),
        source_url: req.body.source_url || null,
        is_verified_content: req.body.is_verified_content === "on",
      },
      req.adminUser.username
    );
    redirect(res, "/admin/knowledge", "Pathway updated.");
  });
});

router.post("/knowledge/pathways/:id/delete", requireAdminRolePage("/admin/knowledge"), async (req, res) => {
  await withError(req, res, "/admin/knowledge", async () => {
    await svc.deletePathway(req.params.id, req.adminUser.username);
    redirect(res, "/admin/knowledge", "Pathway deleted.");
  });
});

router.post("/knowledge/faqs", requireAdminRolePage("/admin/knowledge"), async (req, res) => {
  await withError(req, res, "/admin/knowledge", async () => {
    await svc.createFaq(
      {
        question: req.body.question,
        answer: req.body.answer,
        category: req.body.category || null,
        source_url: req.body.source_url || null,
        is_verified_content: req.body.is_verified_content === "on",
      },
      req.adminUser.username
    );
    redirect(res, "/admin/knowledge", "FAQ added.");
  });
});

router.post("/knowledge/faqs/:id/update", requireAdminRolePage("/admin/knowledge"), async (req, res) => {
  await withError(req, res, "/admin/knowledge", async () => {
    await svc.updateFaq(
      req.params.id,
      {
        question: req.body.question,
        answer: req.body.answer,
        category: req.body.category || null,
        source_url: req.body.source_url || null,
        is_verified_content: req.body.is_verified_content === "on",
      },
      req.adminUser.username
    );
    redirect(res, "/admin/knowledge", "FAQ updated.");
  });
});

router.post("/knowledge/faqs/:id/delete", requireAdminRolePage("/admin/knowledge"), async (req, res) => {
  await withError(req, res, "/admin/knowledge", async () => {
    await svc.deleteFaq(req.params.id, req.adminUser.username);
    redirect(res, "/admin/knowledge", "FAQ deleted.");
  });
});

// --------------------------------------------------------------------------- //
// Staff
// --------------------------------------------------------------------------- //

router.get("/staff", requireAdminRolePage(), async (req, res) => {
  await render(req, res, "staff", "staff", { staff: await svc.listStaff() });
});

router.post("/staff", requireAdminRolePage("/admin/staff"), async (req, res) => {
  await withError(req, res, "/admin/staff", async () => {
    await svc.createStaff(
      { username: req.body.username, password: req.body.password, role: req.body.role || "agent" },
      req.adminUser.username
    );
    redirect(res, "/admin/staff", "Staff account created.");
  });
});

// --------------------------------------------------------------------------- //
// Audit log
// --------------------------------------------------------------------------- //

router.get("/audit-log", requireAdminRolePage(), async (req, res) => {
  await render(req, res, "audit_log", "audit_log", { entries: await svc.listAuditLog(200) });
});

// --------------------------------------------------------------------------- //
// Users
// --------------------------------------------------------------------------- //

router.get("/users", async (req, res) => {
  await render(req, res, "users", "users", { users: await svc.listUsers() });
});

router.post("/users/:id/delete", requireAdminRolePage("/admin/users"), async (req, res) => {
  await withError(req, res, "/admin/users", async () => {
    await svc.deleteUser(req.params.id, req.adminUser.username);
    redirect(res, "/admin/users", "User data deleted.");
  });
});

// --------------------------------------------------------------------------- //
// Applications
// --------------------------------------------------------------------------- //

router.get("/applications", async (req, res) => {
  await render(req, res, "applications", "applications", { applications: await svc.listApplications() });
});

// --------------------------------------------------------------------------- //
// Tasks
// --------------------------------------------------------------------------- //

router.get("/tasks", async (req, res) => {
  await render(req, res, "tasks", "tasks", { tasks: await svc.listTasks(req.query.status || null) });
});

router.post("/tasks", async (req, res) => {
  await withError(req, res, "/admin/tasks", async () => {
    await svc.createTask(
      {
        title: req.body.title,
        description: req.body.description || null,
        priority: req.body.priority || "medium",
        assigned_agent: req.body.assigned_agent || null,
        lead_id: req.body.lead_id || null,
        due_at: req.body.due_at ? new Date(req.body.due_at) : null,
      },
      req.adminUser.username
    );
    redirect(res, "/admin/tasks", "Task created.");
  });
});

router.post("/tasks/:id/update", async (req, res) => {
  await withError(req, res, "/admin/tasks", async () => {
    await svc.updateTask(req.params.id, req.body.status, req.adminUser.username);
    redirect(res, "/admin/tasks", "Task updated.");
  });
});

// --------------------------------------------------------------------------- //
// Payments (internal fee record-keeping — not a payment processor integration)
// --------------------------------------------------------------------------- //

router.get("/payments", async (req, res) => {
  await render(req, res, "payments", "payments", {
    payments: await svc.listPayments(req.query.status || null),
    paymentStats: await svc.paymentStats(),
    users: await svc.listUsers(),
    statusFilter: req.query.status || null,
  });
});

router.post("/payments", async (req, res) => {
  await withError(req, res, "/admin/payments", async () => {
    await svc.createPayment(
      {
        user_id: req.body.user_id,
        lead_id: req.body.lead_id || null,
        amount: req.body.amount,
        currency: req.body.currency || "NGN",
        purpose: req.body.purpose,
        status: req.body.status || "pending",
        method: req.body.method || null,
        reference: req.body.reference || null,
        notes: req.body.notes || null,
      },
      req.adminUser.username
    );
    redirect(res, "/admin/payments", "Payment recorded.");
  });
});

router.post("/payments/:id/update", async (req, res) => {
  await withError(req, res, "/admin/payments", async () => {
    await svc.updatePayment(req.params.id, req.body.status, req.adminUser.username);
    redirect(res, "/admin/payments", "Payment updated.");
  });
});

// --------------------------------------------------------------------------- //
// WhatsApp connection (status + QR pairing) — admin-only since a scanned QR here
// links a new device to the bot's WhatsApp account.
// --------------------------------------------------------------------------- //

async function qrDataUrlOrNull() {
  if (!connectionState.qr) return null;
  return QRCode.toDataURL(connectionState.qr, { margin: 1, width: 280 });
}

router.get("/whatsapp", requireAdminRolePage(), async (req, res) => {
  await render(req, res, "whatsapp", "whatsapp", {
    connectionStatus: connectionState.status,
    qrDataUrl: await qrDataUrlOrNull(),
    botPhoneNumber: (await import("../config.js")).settings.botPhoneNumber || null,
  });
});

// Polled client-side every few seconds so the status/QR update without a full page reload
// (Baileys rotates the QR roughly every 20-60s while waiting for a scan).
router.get("/whatsapp/status.json", async (req, res) => {
  res.json({ status: connectionState.status, qrDataUrl: await qrDataUrlOrNull() });
});

router.post("/whatsapp/relink", requireAdminRolePage("/admin/whatsapp"), async (req, res) => {
  await withError(req, res, "/admin/whatsapp", async () => {
    await logAction({ actor: req.adminUser.username, action: "whatsapp_relink", targetType: "whatsapp" });
    await whatsappClient.relink();
    redirect(res, "/admin/whatsapp", "Relink started — scan the new QR code below.");
  });
});

// --------------------------------------------------------------------------- //
// Settings (read-only view of runtime configuration flags)
// --------------------------------------------------------------------------- //

router.get("/settings", requireAdminRolePage(), async (req, res) => {
  const { settings } = await import("../config.js");
  await render(req, res, "settings", "settings", {
    settings: {
      environment: settings.environment,
      aiConfigured: settings.aiConfigured,
      enableScheduler: settings.enableScheduler,
      enableDataRetentionJob: settings.enableDataRetentionJob,
      dataRetentionDays: settings.dataRetentionDays,
    },
  });
});
