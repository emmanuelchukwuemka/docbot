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
    const where = req.query.country ? { "$country.name$": req.query.country } : {};
    const pathways = await Pathway.findAll({
      where,
      include: [{ model: Country, as: "country" }],
      order: [["name", "ASC"]],
    });
    res.render("portal/pathways", { pathways, filterCountry: req.query.country || null });
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

router.get(
  "/careers",
  wrap(async (req, res) => {
    const jobs = await JobListing.findAll({ where: { is_active: true }, order: [["created_at", "DESC"]] });
    res.render("portal/careers", { jobs });
  })
);
