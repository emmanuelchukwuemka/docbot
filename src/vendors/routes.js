// Partner-agent (Vendor) portal routes — application, login, and the dashboard itself.
// Mounted at server.js alongside portalRouter/adminUiRouter, same "own top-level module"
// shape as admin/ and portal/.

import { Router } from "express";
import multer from "multer";
import { HttpError } from "../admin/httpError.js";
import { DIAL_CODES } from "../portal/dialCodes.js";
import { getSessionVendor, requireVendorLogin, VENDOR_SESSION_KEY } from "./deps.js";
import {
  addVendorDocuments,
  authenticateVendor,
  changeVendorPassword,
  getVendorCase,
  getVendorDashboardSummary,
  listVendorCases,
  listVendorConsultations,
  listVendorDocuments,
  listVendorEarnings,
  listVendorVerificationDocuments,
  sendCaseMessageAsVendor,
  submitVendorApplication,
  updateVendorProfile,
} from "./service.js";

export const router = Router();

// Memory storage (not disk) — both destinations (sharp for the photo, LocalEncryptedStorage
// for documents) work from a Buffer and want to control the actual write themselves
// (resizing / encrypting), so there's no reason to let multer touch disk first.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 6 } });

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

const TITLES = {
  dashboard: "Dashboard",
  profile: "My Profile",
  cases: "Cases",
  case_detail: "Case Detail",
  consultations: "Consultations",
  documents: "Documents",
  earnings: "Earnings",
  settings: "Settings",
};

/** Renders an authenticated dashboard page — always supplies title/active/vendor so
 * vendor/partials/head.ejs never has to guess. Public pages (apply/login) render directly,
 * they don't use this (no sidebar/vendor to show). */
function renderDash(req, res, active, extra = {}) {
  res.render("vendor/" + active.replace("case_detail", "caseDetail"), {
    active,
    title: TITLES[active] || active,
    vendor: req.vendor,
    ...extra,
  });
}

// --------------------------------------------------------------------------- //
// Public: application + login
// --------------------------------------------------------------------------- //

router.get(
  "/agents/apply",
  wrap(async (req, res) => {
    if (await getSessionVendor(req)) return res.redirect(303, "/agents/dashboard");
    res.render("vendor/apply", { error: null, sent: false, values: {}, dialCodes: DIAL_CODES });
  })
);

const applyUpload = upload.fields([
  { name: "photo", maxCount: 1 },
  { name: "documents", maxCount: 5 },
]);

router.post(
  "/agents/apply",
  // Multer errors (file too large/too many files) happen inside this middleware, before the
  // route handler runs at all — handled here directly rather than via wrap()/HttpError so a
  // bad upload re-shows the form with a friendly message instead of a raw 500.
  (req, res, next) => {
    applyUpload(req, res, (err) => {
      if (!err) return next();
      const message = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
        ? "One of your files is too large."
        : "There was a problem with your upload — try again with fewer/smaller files.";
      res.status(400).render("vendor/apply", { error: message, sent: false, values: req.body || {}, dialCodes: DIAL_CODES });
    });
  },
  wrap(async (req, res, next) => {
    try {
      await submitVendorApplication(req.body, req.files || {}, req.ip);
      res.render("vendor/apply", { error: null, sent: true, values: {}, dialCodes: DIAL_CODES });
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("vendor/apply", { error: err.detail, sent: false, values: req.body, dialCodes: DIAL_CODES });
      }
      next(err);
    }
  })
);

router.get(
  "/agents/login",
  wrap(async (req, res) => {
    if (await getSessionVendor(req)) return res.redirect(303, "/agents/dashboard");
    res.render("vendor/login", { error: req.query.error || null });
  })
);

router.post(
  "/agents/login",
  wrap(async (req, res, next) => {
    try {
      const vendor = await authenticateVendor(req.body.email, req.body.password);
      req.session[VENDOR_SESSION_KEY] = vendor.id;
      res.redirect(303, "/agents/dashboard");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("vendor/login", { error: err.detail });
      }
      next(err);
    }
  })
);

router.post("/agents/logout", (req, res) => {
  if (req.session) delete req.session[VENDOR_SESSION_KEY];
  res.redirect(303, "/agents/login");
});

// --------------------------------------------------------------------------- //
// Authenticated dashboard
// --------------------------------------------------------------------------- //

router.get(
  "/agents/dashboard",
  requireVendorLogin,
  wrap(async (req, res) => {
    renderDash(req, res, "dashboard", {
      summary: await getVendorDashboardSummary(req.vendor.id),
      cases: (await listVendorCases(req.vendor.id)).slice(0, 5),
    });
  })
);

router.get(
  "/agents/profile",
  requireVendorLogin,
  wrap(async (req, res) => {
    renderDash(req, res, "profile", {
      error: req.query.error || null,
      saved: req.query.saved === "1",
      documents: await listVendorVerificationDocuments(req.vendor.id),
    });
  })
);

const profileUpload = upload.fields([{ name: "photo", maxCount: 1 }]);

router.post(
  "/agents/profile",
  requireVendorLogin,
  (req, res, next) => {
    profileUpload(req, res, (err) => {
      if (!err) return next();
      const message = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
        ? "Photo is too large."
        : "There was a problem with your upload.";
      res.redirect(303, "/agents/profile?error=" + encodeURIComponent(message));
    });
  },
  wrap(async (req, res, next) => {
    try {
      await updateVendorProfile(req.vendor.id, req.body, req.files?.photo?.[0] || null);
      res.redirect(303, "/agents/profile?saved=1");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("vendor/profile", {
          active: "profile", title: TITLES.profile, vendor: req.vendor, error: err.detail, saved: false,
          documents: await listVendorVerificationDocuments(req.vendor.id),
        });
      }
      next(err);
    }
  })
);

const documentsUpload = upload.fields([{ name: "documents", maxCount: 5 }]);

router.post(
  "/agents/profile/documents",
  requireVendorLogin,
  (req, res, next) => {
    documentsUpload(req, res, (err) => {
      if (!err) return next();
      const message = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
        ? "One of your files is too large."
        : "There was a problem with your upload.";
      res.redirect(303, "/agents/profile?error=" + encodeURIComponent(message));
    });
  },
  wrap(async (req, res, next) => {
    try {
      await addVendorDocuments(req.vendor.id, req.files?.documents || []);
      res.redirect(303, "/agents/profile?saved=1");
    } catch (err) {
      if (err instanceof HttpError) return res.redirect(303, "/agents/profile?error=" + encodeURIComponent(err.detail));
      next(err);
    }
  })
);

router.get(
  "/agents/cases",
  requireVendorLogin,
  wrap(async (req, res) => {
    renderDash(req, res, "cases", { cases: await listVendorCases(req.vendor.id) });
  })
);

router.get(
  "/agents/cases/:id",
  requireVendorLogin,
  wrap(async (req, res, next) => {
    try {
      const caseData = await getVendorCase(req.vendor.id, req.params.id);
      renderDash(req, res, "case_detail", { caseData, error: req.query.error || null });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return res.redirect(303, "/agents/cases");
      next(err);
    }
  })
);

router.post(
  "/agents/cases/:id/messages",
  requireVendorLogin,
  wrap(async (req, res, next) => {
    try {
      await sendCaseMessageAsVendor(req.vendor.id, req.params.id, req.body.body);
      res.redirect(303, "/agents/cases/" + req.params.id);
    } catch (err) {
      if (err instanceof HttpError) return res.redirect(303, "/agents/cases/" + req.params.id + "?error=" + encodeURIComponent(err.detail));
      next(err);
    }
  })
);

router.get(
  "/agents/consultations",
  requireVendorLogin,
  wrap(async (req, res) => {
    renderDash(req, res, "consultations", { consultations: await listVendorConsultations(req.vendor.id) });
  })
);

router.get(
  "/agents/documents",
  requireVendorLogin,
  wrap(async (req, res) => {
    renderDash(req, res, "documents", { documents: await listVendorDocuments(req.vendor.id) });
  })
);

router.get(
  "/agents/earnings",
  requireVendorLogin,
  wrap(async (req, res) => {
    renderDash(req, res, "earnings", { earnings: await listVendorEarnings(req.vendor.id) });
  })
);

router.get(
  "/agents/settings",
  requireVendorLogin,
  wrap(async (req, res) => {
    renderDash(req, res, "settings", { error: null, saved: req.query.saved === "1" });
  })
);

router.post(
  "/agents/settings/password",
  requireVendorLogin,
  wrap(async (req, res, next) => {
    try {
      await changeVendorPassword(req.vendor.id, req.body.current_password, req.body.new_password);
      res.redirect(303, "/agents/settings?saved=1");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("vendor/settings", {
          active: "settings", title: TITLES.settings, vendor: req.vendor, error: err.detail, saved: false,
        });
      }
      next(err);
    }
  })
);

router.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res
    .status(500)
    .send(
      '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:80px 20px">' +
        "<h1>Something went wrong</h1><p>Please try again in a moment.</p>" +
        '<a href="/agents/dashboard">Back to dashboard</a></body></html>'
    );
});
