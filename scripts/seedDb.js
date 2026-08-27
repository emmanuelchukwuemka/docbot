// Create tables (if needed) and load development knowledge-base seed data.
//
// Usage: node scripts/seedDb.js

import { connectDb, sequelize } from "../src/db/sequelize.js";
import { syncModels, Country, Pathway, FAQ } from "../src/db/models.js";
import { COUNTRIES, PATHWAYS, FAQS } from "../src/knowledgeBase/seedData.js";

async function seed() {
  await connectDb();
  await syncModels();

  if ((await Country.count()) > 0) {
    console.log("Knowledge base already seeded — skipping.");
    await sequelize.close();
    return;
  }

  const countriesByName = {};
  for (const c of COUNTRIES) {
    countriesByName[c.name] = await Country.create({
      name: c.name,
      code: c.code,
      official_resources: c.official_resources ?? [],
    });
  }

  for (const p of PATHWAYS) {
    await Pathway.create({
      country_id: countriesByName[p.country].id,
      name: p.name,
      category: p.category,
      summary: p.summary ?? null,
      eligibility_criteria: p.eligibility_criteria ?? {},
      requirements: p.requirements ?? [],
      documents: p.documents ?? [],
      government_fees: p.government_fees ?? null,
      service_fees: p.service_fees ?? null,
      typical_processing_time: p.typical_processing_time ?? null,
      language_requirements: p.language_requirements ?? null,
      is_verified_content: false,
    });
  }

  for (const f of FAQS) {
    await FAQ.create({
      question: f.question,
      answer: f.answer,
      category: f.category ?? null,
      is_verified_content: false,
    });
  }

  console.log(`Seeded ${COUNTRIES.length} countries, ${PATHWAYS.length} pathways, ${FAQS.length} FAQs.`);
  await sequelize.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
