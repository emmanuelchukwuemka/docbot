// Web self-service portal — register/login/dashboard pages for MigraTech's customer-facing
// site (as opposed to admin/ which is the staff dashboard). Server-rendered EJS, same
// approach as the admin dashboard, styled to match the public marketing site's brand instead
// of the plain admin login box.

import { Router } from "express";
import { logger } from "../logger.js";
import { settings } from "../config.js";
import { HttpError } from "../admin/httpError.js";
import { REGISTRATION_COUNTRIES } from "./countries.js";
import { DIAL_CODES } from "./dialCodes.js";
import { getPendingVerifyUser, getSessionUser, PENDING_VERIFY_SESSION_KEY, requireLogin, SESSION_KEY } from "./deps.js";
import { sendOtp, verifyOtp } from "./otp.js";
import {
  authenticateUser,
  bookConsultation,
  changePassword,
  changeWhatsappNumber,
  findRegisteredUserByIdentifier,
  getDashboardData,
  registerUser,
  setNewPassword,
  submitContactMessage,
  updateProfile,
} from "./service.js";

export const router = Router();

// Express 4 doesn't catch a rejected promise from an async route handler on its own — an
// uncaught one becomes an unhandled rejection that crashes the *entire* process (WhatsApp
// connection, admin dashboard, everything), not just this one request. Every handler below
// is wrapped so a DB hiccup here is a 500 response, not a full outage — found the hard way
// while testing this feature, against a real missing-column bug (see
// scripts/addPaymentTierColumn.js) that had nothing to do with the portal itself.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Real, live config values (not hardcoded into the static homepage) — so the landing
// page's plan pricing can never drift from what checkout actually charges. NAVIGATE is a
// fixed self-serve price; RELOCATE is deliberately variable (staff quote it per pathway),
// so only its "starting around" reference figure is exposed here — same framing config.js
// itself uses.
router.get("/api/pricing", (req, res) => {
  res.json({
    navigate_price_ngn: settings.navigatePriceNgn,
    navigate_price_usd_display: settings.navigatePriceUsdDisplay,
    relocate_reference_price_ngn: settings.relocateReferencePriceNgn,
    relocate_reference_price_usd_display: settings.relocateReferencePriceUsdDisplay,
  });
});

router.get(
  "/register",
  wrap(async (req, res) => {
    if (await getSessionUser(req)) return res.redirect(303, "/dashboard");
    res.render("portal/register", { error: null, values: {}, countries: REGISTRATION_COUNTRIES, dialCodes: DIAL_CODES });
  })
);

router.post(
  "/register",
  wrap(async (req, res, next) => {
    try {
      const user = await registerUser(req.body, req.ip);
      // Deliberately does NOT set SESSION_KEY yet — see PENDING_VERIFY_SESSION_KEY in
      // deps.js. Registration isn't "done" until they prove they actually control this
      // WhatsApp number.
      req.session[PENDING_VERIFY_SESSION_KEY] = user.id;
      try {
        await sendOtp(user, { purpose: "verify" });
      } catch (otpErr) {
        if (otpErr instanceof HttpError) {
          // Account exists, but couldn't send the code — still send them to /verify (where
          // "resend" can retry) rather than losing the account they just created.
          return res.redirect(303, "/verify?error=" + encodeURIComponent(otpErr.detail));
        }
        throw otpErr;
      }
      res.redirect(303, "/verify");
    } catch (err) {
      if (err instanceof HttpError) {
        return res
          .status(err.status)
          .render("portal/register", {
            error: err.detail,
            values: req.body,
            countries: REGISTRATION_COUNTRIES,
            dialCodes: DIAL_CODES,
          });
      }
      next(err);
    }
  })
);

router.get(
  "/login",
  wrap(async (req, res) => {
    if (await getSessionUser(req)) return res.redirect(303, "/dashboard");
    res.render("portal/login", { error: null });
  })
);

router.post(
  "/login",
  wrap(async (req, res, next) => {
    try {
      const user = await authenticateUser(req.body.identifier, req.body.password);
      if (!user.is_verified) {
        req.session[PENDING_VERIFY_SESSION_KEY] = user.id;
        try {
          await sendOtp(user, { purpose: "verify" });
        } catch (otpErr) {
          if (otpErr instanceof HttpError) {
            return res.redirect(303, "/verify?error=" + encodeURIComponent(otpErr.detail));
          }
          throw otpErr;
        }
        return res.redirect(303, "/verify");
      }
      req.session[SESSION_KEY] = user.id;
      res.redirect(303, "/dashboard");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("portal/login", { error: err.detail });
      }
      next(err);
    }
  })
);

// Only clears this portal's own session key(s) — never the whole session — so it can't log a
// staff member out of /admin if the same browser somehow holds both (see deps.js).
router.post("/logout", (req, res) => {
  if (req.session) {
    delete req.session[SESSION_KEY];
    delete req.session[PENDING_VERIFY_SESSION_KEY];
  }
  res.redirect(303, "/");
});

// --------------------------------------------------------------------------- //
// WhatsApp-OTP verification (registration, and any login before verification completed)
// --------------------------------------------------------------------------- //

// Already-verified accounts can end up holding a pending-verify session (e.g. they reset
// their password via the same OTP mechanism, which also marks them verified) — send those
// straight through instead of asking them to verify something that's already done.
async function resolveAlreadyVerified(req, res) {
  const user = await getPendingVerifyUser(req);
  if (!user) {
    res.redirect(303, "/login");
    return null;
  }
  if (user.is_verified) {
    delete req.session[PENDING_VERIFY_SESSION_KEY];
    req.session[SESSION_KEY] = user.id;
    res.redirect(303, "/dashboard");
    return null;
  }
  return user;
}

router.get(
  "/verify",
  wrap(async (req, res) => {
    const user = await resolveAlreadyVerified(req, res);
    if (!user) return;
    res.render("portal/verify", { error: req.query.error || null, sent: req.query.sent === "1" });
  })
);

router.post(
  "/verify",
  wrap(async (req, res, next) => {
    const user = await resolveAlreadyVerified(req, res);
    if (!user) return;
    try {
      await verifyOtp(user, req.body.code);
      user.is_verified = true;
      await user.save();
      delete req.session[PENDING_VERIFY_SESSION_KEY];
      req.session[SESSION_KEY] = user.id;
      res.redirect(303, "/dashboard");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("portal/verify", { error: err.detail, sent: false });
      }
      next(err);
    }
  })
);

router.post(
  "/verify/resend",
  wrap(async (req, res, next) => {
    const user = await resolveAlreadyVerified(req, res);
    if (!user) return;
    try {
      await sendOtp(user, { purpose: "verify" });
      res.redirect(303, "/verify?sent=1");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect(303, "/verify?error=" + encodeURIComponent(err.detail));
      }
      next(err);
    }
  })
);

// --------------------------------------------------------------------------- //
// Password reset (WhatsApp OTP)
// --------------------------------------------------------------------------- //

router.get(
  "/forgot-password",
  wrap(async (req, res) => {
    res.render("portal/forgotPassword", { sent: false, error: null });
  })
);

router.post(
  "/forgot-password",
  wrap(async (req, res, next) => {
    try {
      const user = await findRegisteredUserByIdentifier(req.body.identifier);
      if (user) {
        // Swallow a send failure here rather than surfacing it — revealing "WhatsApp is
        // down" would also reveal that this identifier *does* have an account, defeating
        // the enumeration protection below.
        await sendOtp(user, { purpose: "reset" }).catch(() => {});
        req.session[PENDING_VERIFY_SESSION_KEY] = user.id;
      }
      // Same response whether or not an account exists — don't let this form be used to
      // probe which emails/numbers are registered.
      res.render("portal/forgotPassword", { sent: true, error: null });
    } catch (err) {
      next(err);
    }
  })
);

router.get(
  "/reset-password",
  wrap(async (req, res) => {
    const user = await getPendingVerifyUser(req);
    if (!user) return res.redirect(303, "/forgot-password");
    res.render("portal/resetPassword", { error: req.query.error || null });
  })
);

router.post(
  "/reset-password/resend",
  wrap(async (req, res, next) => {
    const user = await getPendingVerifyUser(req);
    if (!user) return res.redirect(303, "/forgot-password");
    try {
      await sendOtp(user, { purpose: "reset" });
      res.redirect(303, "/reset-password");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect(303, "/reset-password?error=" + encodeURIComponent(err.detail));
      }
      next(err);
    }
  })
);

router.post(
  "/reset-password",
  wrap(async (req, res, next) => {
    const user = await getPendingVerifyUser(req);
    if (!user) return res.redirect(303, "/forgot-password");
    try {
      await verifyOtp(user, req.body.code);
      if (req.body.password !== req.body.password_confirm) {
        throw new HttpError(400, "Passwords don't match.");
      }
      await setNewPassword(user.id, req.body.password);
      user.is_verified = true; // resetting via a WhatsApp-delivered code proves the same thing verification does
      await user.save();
      delete req.session[PENDING_VERIFY_SESSION_KEY];
      req.session[SESSION_KEY] = user.id;
      res.redirect(303, "/dashboard?msg=" + encodeURIComponent("Password updated."));
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("portal/resetPassword", { error: err.detail });
      }
      next(err);
    }
  })
);

// --------------------------------------------------------------------------- //
// Account settings
// --------------------------------------------------------------------------- //

router.get(
  "/settings",
  wrap(requireLogin),
  wrap(async (req, res) => {
    res.render("portal/settings", {
      user: req.portalUser,
      countries: REGISTRATION_COUNTRIES,
      dialCodes: DIAL_CODES,
      profileError: req.query.profileError || null,
      profileSuccess: req.query.profileSuccess || null,
      passwordError: req.query.passwordError || null,
      passwordSuccess: req.query.passwordSuccess || null,
      phoneError: req.query.phoneError || null,
      phoneSuccess: req.query.phoneSuccess || null,
    });
  })
);

router.post(
  "/settings/profile",
  wrap(requireLogin),
  wrap(async (req, res, next) => {
    try {
      await updateProfile(req.portalUser.id, req.body);
      res.redirect(303, "/settings?profileSuccess=" + encodeURIComponent("Profile updated."));
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect(303, "/settings?profileError=" + encodeURIComponent(err.detail));
      }
      next(err);
    }
  })
);

router.post(
  "/settings/password",
  wrap(requireLogin),
  wrap(async (req, res, next) => {
    try {
      if (req.body.new_password !== req.body.new_password_confirm) {
        throw new HttpError(400, "New passwords don't match.");
      }
      await changePassword(req.portalUser.id, req.body.current_password, req.body.new_password);
      res.redirect(303, "/settings?passwordSuccess=" + encodeURIComponent("Password changed."));
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect(303, "/settings?passwordError=" + encodeURIComponent(err.detail));
      }
      next(err);
    }
  })
);

router.post(
  "/settings/phone",
  wrap(requireLogin),
  wrap(async (req, res, next) => {
    try {
      await changeWhatsappNumber(
        req.portalUser.id,
        req.body.current_password,
        req.body.whatsapp_dial_code,
        req.body.whatsapp_local_number
      );
      res.redirect(303, "/settings?phoneSuccess=" + encodeURIComponent("WhatsApp number updated."));
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect(303, "/settings?phoneError=" + encodeURIComponent(err.detail));
      }
      next(err);
    }
  })
);

router.get(
  "/dashboard",
  wrap(requireLogin),
  wrap(async (req, res) => {
    const data = await getDashboardData(req.portalUser.id);
    res.render("portal/dashboard", {
      ...data,
      flashMessage: req.query.msg || null,
      flashError: req.query.error || null,
    });
  })
);

router.post(
  "/consultation",
  wrap(requireLogin),
  wrap(async (req, res, next) => {
    try {
      await bookConsultation(req.portalUser.id, req.body);
      res.redirect(303, "/dashboard?msg=" + encodeURIComponent("Consultation requested — we'll confirm a time shortly.") + "#consultation");
    } catch (err) {
      if (err instanceof HttpError) {
        return res.redirect(303, "/dashboard?error=" + encodeURIComponent(err.detail) + "#consultation");
      }
      next(err);
    }
  })
);

router.get(
  "/contact",
  wrap(async (req, res) => {
    const sessionUser = await getSessionUser(req);
    res.render("portal/contact", {
      loggedInName: sessionUser ? sessionUser.name || "there" : null,
      sessionUser,
      error: null,
      sent: false,
      values: {},
    });
  })
);

router.post(
  "/contact/message",
  wrap(async (req, res, next) => {
    const sessionUser = await getSessionUser(req);
    try {
      await submitContactMessage(req.body, sessionUser, req.ip);
      res.render("portal/contact", {
        loggedInName: sessionUser ? sessionUser.name || "there" : null,
        sessionUser,
        error: null,
        sent: true,
        values: {},
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).render("portal/contact", {
          loggedInName: sessionUser ? sessionUser.name || "there" : null,
          sessionUser,
          error: err.detail,
          sent: false,
          values: req.body,
        });
      }
      next(err);
    }
  })
);

// Generic fallback for anything unexpected (DB errors, etc.) — logs full detail server-side,
// shows the visitor a plain apology instead of a stack trace or taking the whole app down.
router.use((err, req, res, next) => {
  logger.error({ err }, "Unhandled error in portal route");
  if (res.headersSent) return next(err);
  res
    .status(500)
    .send(
      '<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:80px 20px">' +
        "<h1>Something went wrong</h1><p>Please try again in a moment.</p>" +
        '<a href="/">Back to MigraTech</a></body></html>'
    );
});
