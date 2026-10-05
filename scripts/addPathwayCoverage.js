// One-off: seedDb.js only seeds on a completely empty knowledge base (it skips once any
// Country row exists), so the new countries/pathways added to seedData.js on 2026-09-28
// (US, Australia, plus filling Canada/UK/Germany's missing categories) don't reach a database
// that was already seeded (production). Idempotent — skips any country/pathway that already
// exists by name (+ category, for pathways).
import { connectDb, sequelize } from "../src/db/sequelize.js";
import { Country, Pathway } from "../src/db/models.js";
import { COUNTRIES, PATHWAYS } from "../src/knowledgeBase/seedData.js";

async function run() {
  await connectDb();

  let countriesAdded = 0;
  for (const c of COUNTRIES) {
    const [, created] = await Country.findOrCreate({
      where: { name: c.name },
      defaults: { code: c.code, official_resources: c.official_resources ?? [] },
    });
    if (created) countriesAdded += 1;
  }

  const countriesByName = {};
  for (const c of await Country.findAll()) countriesByName[c.name] = c;

  let pathwaysAdded = 0;
  for (const p of PATHWAYS) {
    const country = countriesByName[p.country];
    if (!country) throw new Error(`Country not found for pathway: ${p.country}`);
    const [, created] = await Pathway.findOrCreate({
      where: { country_id: country.id, name: p.name, category: p.category },
      defaults: {
        summary: p.summary ?? null,
        eligibility_criteria: p.eligibility_criteria ?? {},
        requirements: p.requirements ?? [],
        documents: p.documents ?? [],
        government_fees: p.government_fees ?? null,
        service_fees: p.service_fees ?? null,
        typical_processing_time: p.typical_processing_time ?? null,
        language_requirements: p.language_requirements ?? null,
        is_verified_content: false,
      },
    });
    if (created) pathwaysAdded += 1;
  }

  console.log(`Added ${countriesAdded} countries, ${pathwaysAdded} pathways.`);
  await sequelize.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
