// One-off: discovered 2026-09-28 that production's FAQ table had exactly one row (the "What
// is MigraTech?" entry added by a now-removed narrower script) -- the original 7 FAQs in
// seedData.js were apparently never actually seeded against the live database (only ever run
// via scripts/seedDb.js locally). This backfills every entry in FAQS idempotently (by
// question text), so it's safe to re-run any time seedData.js gains new FAQs later instead of
// writing another narrow one-off script per entry.
import { connectDb, sequelize } from "../src/db/sequelize.js";
import { FAQ } from "../src/db/models.js";
import { FAQS } from "../src/knowledgeBase/seedData.js";

async function run() {
  await connectDb();

  let added = 0;
  for (const f of FAQS) {
    const [, created] = await FAQ.findOrCreate({
      where: { question: f.question },
      defaults: { answer: f.answer, category: f.category ?? null, is_verified_content: false },
    });
    if (created) added += 1;
  }

  console.log(`Added ${added} FAQ(s) (${FAQS.length - added} already present).`);
  await sequelize.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
