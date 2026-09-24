// Public read-only views of admin-managed data: the migration knowledge base
// (Country/Pathway, managed at /admin/knowledge) and company info (TeamMember/JobListing,
// managed at /admin/company).

import { Router } from "express";
import { Country, JobListing, Pathway, TeamMember } from "../db/models.js";

export const router = Router();

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get(
  "/countries",
  wrap(async (req, res) => {
    const countries = await Country.findAll({ order: [["name", "ASC"]] });
    res.render("portal/countries", { countries });
  })
);

router.get(
  "/pathways",
  wrap(async (req, res) => {
    const where = {};
    if (req.query.country) where["$country.name$"] = req.query.country;
    // Real values seeded in the pathways table today: work / study / family — same category
    // strings the WhatsApp bot's own eligibility engine filters on (see eligibility/engine.js),
    // so a link like /pathways?category=work shows exactly what that flow would.
    if (req.query.category) where.category = req.query.category;
    const pathways = await Pathway.findAll({
      where,
      include: [{ model: Country, as: "country" }],
      order: [["name", "ASC"]],
    });
    res.render("portal/pathways", {
      pathways,
      filterCountry: req.query.country || null,
      filterCategory: req.query.category || null,
    });
  })
);

router.get(
  "/team",
  wrap(async (req, res) => {
    const members = await TeamMember.findAll({
      where: { is_active: true },
      order: [["display_order", "ASC"], ["created_at", "ASC"]],
    });
    res.render("portal/team", { members });
  })
);

// Hub page linking out to the real content sections below (Guides, Countries, Blog, FAQs) —
// no DB query of its own, just an index. The "Migration Calculator" card is intentionally
// left unlinked/marked "Coming Soon" rather than pointing at a page that doesn't exist yet —
// see the memory note on this if it's ever asked about again.
router.get("/resources", (req, res) => {
  res.render("portal/resources");
});

// Static service-overview page — was a dead "Services" dropdown stub in the nav (no href, no
// panel) before this. Cards route to WhatsApp for the conversational services (discovery,
// assessment, planning, relocation) and to /pathways?category=<work|study|family> for the
// three that map onto real seeded pathway categories.
router.get("/services", (req, res) => {
  res.render("portal/services");
});

router.get(
  "/careers",
  wrap(async (req, res) => {
    const jobs = await JobListing.findAll({ where: { is_active: true }, order: [["created_at", "DESC"]] });
    res.render("portal/careers", { jobs });
  })
);
