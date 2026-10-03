// One-off: seedDb.js only seeds FAQs on a completely empty knowledge base (it skips once any
// Country row exists), so adding a new FAQ to src/knowledgeBase/seedData.js doesn't reach a
// database that's already seeded (production). Run directly on any environment where the
// knowledge base was seeded before this FAQ existed. Idempotent (checks for an existing match
// on the question before inserting).
import { connectDb, sequelize } from "../src/db/sequelize.js";
import { FAQ } from "../src/db/models.js";
import { FAQS } from "../src/knowledgeBase/seedData.js";

async function run() {
  await connectDb();
  const entry = FAQS.find((f) => f.question === "What is MigraTech?");
  if (!entry) throw new Error("Expected FAQ not found in seedData.js");

  const existing = await FAQ.findOne({ where: { question: entry.question } });
  if (existing) {
    console.log("FAQ already present — skipping.");
  } else {
    await FAQ.create({
      question: entry.question,
      answer: entry.answer,
      category: entry.category ?? null,
      is_verified_content: false,
    });
    console.log("FAQ added.");
  }
  await sequelize.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
