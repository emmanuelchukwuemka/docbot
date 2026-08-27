// PRD section 30 — Admin Dashboard, JSON API.
//
// Session-cookie protected against DB-backed staff accounts (see deps.js) with two roles:
// `agent` (leads/conversations/documents/consultations/tasks) and `admin` (also
// knowledge-base and staff-account management, per PRD section 36's role-based access
// control ask). See admin/uiRoutes.js for the server-rendered dashboard built on these same
// service functions.

import { Router } from "express";
import { requireAdmin, requireAdminRole } from "./deps.js";
import { HttpError } from "./httpError.js";
import * as svc from "./service.js";

export const router = Router();
router.use(requireAdmin);

function handle(fn) {
  return async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ detail: err.detail });
      } else {
        req.log?.error?.(err) ?? console.error(err);
        res.status(500).json({ detail: "Internal server error" });
      }
    }
  };
}

router.get("/overview", handle(() => svc.overview()));
router.get("/dashboard-charts", handle(() => svc.dashboardCharts()));

router.get("/leads", handle((req) => svc.listLeads(req.query.classification || null)));
router.patch(
  "/leads/:id",
  handle((req) => svc.updateLead(req.params.id, req.body, req.adminUser.username))
);

router.get("/conversations", handle((req) => svc.listConversations(req.query.escalated_only === "true")));
router.get("/conversations/:id", handle((req) => svc.getConversation(req.params.id)));
router.post(
  "/conversations/:id/resolve",
  handle((req) => svc.resolveConversation(req.params.id, req.body.resolved_by, req.adminUser.username))
);
router.post(
  "/conversations/:id/send",
  handle((req) => svc.sendStaffMessage(req.params.id, req.body.text, req.adminUser.username))
);
router.post(
  "/conversations/:id/return-to-bot",
  handle((req) => svc.returnConversationToBot(req.params.id, req.adminUser.username))
);

router.get("/documents", handle((req) => svc.listDocuments(req.query.status || null)));
router.patch(
  "/documents/:id",
  handle((req) => svc.reviewDocument(req.params.id, req.body.verification_status, req.adminUser.username))
);

router.get("/consultations", handle((req) => svc.listConsultations(req.query.status || null)));
router.patch(
  "/consultations/:id",
  handle((req) => svc.updateConsultation(req.params.id, req.body.status, req.adminUser.username))
);

router.get("/knowledge/countries", handle(() => svc.listCountries()));
router.post(
  "/knowledge/countries",
  requireAdminRole,
  handle((req) => svc.createCountry(req.body, req.adminUser.username))
);
router.patch(
  "/knowledge/countries/:id",
  requireAdminRole,
  handle((req) => svc.updateCountry(req.params.id, req.body, req.adminUser.username))
);

router.get("/knowledge/pathways", handle(() => svc.listPathways()));
router.post(
  "/knowledge/pathways",
  requireAdminRole,
  handle((req) => svc.createPathway(req.body, req.adminUser.username))
);
router.patch(
  "/knowledge/pathways/:id",
  requireAdminRole,
  handle((req) => svc.updatePathway(req.params.id, req.body, req.adminUser.username))
);
router.delete(
  "/knowledge/pathways/:id",
  requireAdminRole,
  handle((req) => svc.deletePathway(req.params.id, req.adminUser.username))
);

router.get("/knowledge/faqs", handle(() => svc.listFaqs()));
router.post(
  "/knowledge/faqs",
  requireAdminRole,
  handle((req) => svc.createFaq(req.body, req.adminUser.username))
);
router.patch(
  "/knowledge/faqs/:id",
  requireAdminRole,
  handle((req) => svc.updateFaq(req.params.id, req.body, req.adminUser.username))
);
router.delete(
  "/knowledge/faqs/:id",
  requireAdminRole,
  handle((req) => svc.deleteFaq(req.params.id, req.adminUser.username))
);

router.get("/staff", requireAdminRole, handle(() => svc.listStaff()));
router.post(
  "/staff",
  requireAdminRole,
  handle((req) => svc.createStaff(req.body, req.adminUser.username))
);

router.get("/audit-log", requireAdminRole, handle((req) => svc.listAuditLog(Number(req.query.limit) || 200)));

router.delete(
  "/users/:id",
  requireAdminRole,
  handle((req) => svc.deleteUser(req.params.id, req.adminUser.username))
);
router.get("/users", handle(() => svc.listUsers()));

router.get("/applications", handle(() => svc.listApplications()));

router.get("/tasks", handle((req) => svc.listTasks(req.query.status || null)));
router.post(
  "/tasks",
  handle((req) => svc.createTask(req.body, req.adminUser.username))
);
router.patch(
  "/tasks/:id",
  handle((req) => svc.updateTask(req.params.id, req.body.status, req.adminUser.username))
);

router.get("/payments", handle((req) => svc.listPayments(req.query.status || null)));
router.get("/payments/stats", handle(() => svc.paymentStats()));
router.post(
  "/payments",
  handle((req) => svc.createPayment(req.body, req.adminUser.username))
);
router.patch(
  "/payments/:id",
  handle((req) => svc.updatePayment(req.params.id, req.body.status, req.adminUser.username))
);
