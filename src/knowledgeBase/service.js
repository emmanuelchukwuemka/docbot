// Knowledge base query functions.
//
// Retrieval here uses simple keyword scoring rather than vector embeddings. This is a
// deliberate MVP simplification: it needs no extra embeddings API/vector store, and is
// "good enough" to ground FAQ/pathway answers for a first version. If retrieval quality
// becomes a bottleneck, swap `score` below for a real vector similarity query without
// changing the exported functions' signatures.

import { Op } from "sequelize";
import { FAQ, Country, Pathway } from "../db/models.js";

const WORD_RE = /[a-z0-9']+/g;

function tokenize(text) {
  return new Set((text.toLowerCase().match(WORD_RE)) || []);
}

function score(queryTokens, candidate) {
  const candidateTokens = tokenize(candidate);
  let count = 0;
  for (const t of queryTokens) if (candidateTokens.has(t)) count += 1;
  return count;
}

export async function getCountryByName(name) {
  return Country.findOne({ where: { name: { [Op.like]: `%${name}%` } } });
}

export async function getPathwaysForCountry(countryName, category = null) {
  const country = await getCountryByName(countryName);
  if (!country) return [];
  const pathways = await Pathway.findAll({ where: { country_id: country.id }, include: [{ model: Country, as: "country" }] });
  return category ? pathways.filter((p) => p.category === category) : pathways;
}

export async function listCountries() {
  return Country.findAll();
}

export async function searchFaqs(query, topK = 3) {
  const queryTokens = tokenize(query);
  if (!queryTokens.size) return [];
  const allFaqs = await FAQ.findAll();
  const scored = allFaqs
    .map((f) => [score(queryTokens, `${f.question} ${f.answer}`), f])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0]);
  return scored.slice(0, topK).map(([, f]) => f);
}

export async function searchPathways(query, topK = 3) {
  const queryTokens = tokenize(query);
  if (!queryTokens.size) return [];
  const allPathways = await Pathway.findAll({ include: [{ model: Country, as: "country" }] });
  const scored = allPathways
    .map((p) => [score(queryTokens, `${p.country.name} ${p.name} ${p.summary || ""}`), p])
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0]);
  return scored.slice(0, topK).map(([, p]) => p);
}
