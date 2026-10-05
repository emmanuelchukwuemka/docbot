// FR-02 Migration Goal Assessment / FR-03 Destination Discovery.
//
// MIGRA Discover deep intake (redesigned 2026-09-28, per product spec) — a single universal,
// 8-section question list (not split per goal category like the old FLOWS object was) that
// ConversationManager walks field-by-field, skipping any field the profile already has a
// value for, same re-scan pattern as before. "Full name"/"current country"/"current region"
// are deliberately NOT asked here — they reuse User.name (collected during onboarding, before
// any menu is ever shown) and User.country/.state, via each question's optional `target: "user"`
// (default "profile").

function textParser(text) {
  const trimmed = text.trim();
  return trimmed || null;
}

function intParser(text) {
  const match = text.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

function confidenceParser(text) {
  const match = text.match(/\d+/);
  if (!match) return null;
  const n = parseInt(match[0], 10);
  return n >= 1 && n <= 5 ? n : null;
}

function dateParser(text) {
  const trimmed = text.trim();
  let m = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (!Number.isNaN(new Date(iso).getTime())) return iso;
  }
  m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    const iso = `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    if (!Number.isNaN(new Date(iso).getTime())) return iso;
  }
  return null;
}

const YES_WORDS = new Set(["yes", "y", "yeah", "yep", "yup"]);
const NO_WORDS = new Set(["no", "n", "nope", "not applicable", "n/a", "na", "none"]);
function yesNoParser(text) {
  const lowered = text.trim().toLowerCase();
  if (YES_WORDS.has(lowered)) return true;
  if (NO_WORDS.has(lowered)) return false;
  return null;
}

/** Resolves a typed/tapped answer against `options` (by exact/substring text match, or a
 * 1-indexed number) and returns the corresponding entry from `codes` — pass the same array
 * for both to just store the matched option's own label text. */
function makeOptionParser(options, codes) {
  return function (text) {
    const lowered = text.trim().toLowerCase();
    for (let i = 0; i < options.length; i++) {
      const optionLower = options[i].toLowerCase();
      if (optionLower === lowered || (lowered && optionLower.includes(lowered))) return codes[i];
    }
    const match = text.match(/\d+/);
    if (match) {
      const idx = parseInt(match[0], 10) - 1;
      if (idx >= 0 && idx < codes.length) return codes[idx];
    }
    return null;
  };
}

/** WhatsApp has no native multi-select interactive message — a list/button tap returns exactly
 * one selection. This accepts a free-text reply of comma/space-separated numbers (or option
 * text mentioned directly) and returns an array of matched option labels, for the two
 * "allow multiple selections" questions in Preferences & Constraints. */
function multiParser(options) {
  return function (text) {
    const stripped = text.trim();
    if (!stripped) return null;
    const numberMatches = stripped.match(/\d+/g);
    if (numberMatches && numberMatches.length) {
      const picked = [];
      for (const n of numberMatches) {
        const idx = parseInt(n, 10) - 1;
        if (idx >= 0 && idx < options.length && !picked.includes(options[idx])) picked.push(options[idx]);
      }
      if (picked.length) return picked;
    }
    const lowered = stripped.toLowerCase();
    const picked = options.filter((o) => lowered.includes(o.toLowerCase()));
    return picked.length ? picked : null;
  };
}

export const TIMELINE_OPTIONS = [
  "Within 3 months", "3–6 months", "6–12 months", "1–2 years", "More than 2 years", "I'm just exploring",
];
export const TIMELINE_CODES = [
  "within_3_months", "3_6_months", "6_12_months", "1_2_years", "more_than_2_years", "just_exploring",
];
const timelineParser = makeOptionParser(TIMELINE_OPTIONS, TIMELINE_CODES);

/** `target` defaults to "profile"; pass "user" for the two fields reusing User.country/.state.
 * `skipIf(profile)` — if true, the field-scan treats this question as not applicable and moves
 * on without asking it (used for the doc's own "If yes:" conditional sub-questions).
 * `allowSkip` — user may reply "skip" to leave it blank (stored as "" so the scan doesn't
 * re-ask it forever); reserved for the doc's explicit "(Optional)" fields plus the two most
 * sensitive follow-ups (visa refusal reason, asylum context), never used as a general
 * friction-reduction shortcut. */
function question(fieldName, prompt, parser = textParser, options = [], extra = {}) {
  return { field_name: fieldName, prompt, parser, options, target: "profile", ...extra };
}

function skipUnless(field, value = true) {
  return (profile) => profile[field] !== value;
}

// migration_reason's 13 options map down to this existing 6-value category set, which
// _bestMatchingPathway/assess() (eligibility/engine.js) and the pathway knowledge base already
// key off — kept so none of that matching logic needed to change for this redesign.
export const MIGRATION_REASON_OPTIONS = [
  "Work", "Study", "Business/Entrepreneurship", "Family reunification", "Better quality of life",
  "Healthcare/medical reasons", "Visit/temporary stay", "Permanent settlement", "Investment",
  "Religious/missionary work", "Refuge/asylum/protection", "I am not sure yet", "Other",
];
const MIGRATION_REASON_TO_OBJECTIVE = {
  "Work": "work",
  "Study": "study",
  "Business/Entrepreneurship": "business",
  "Family reunification": "family",
  "Better quality of life": "unsure",
  "Healthcare/medical reasons": "unsure",
  "Visit/temporary stay": "visit",
  "Permanent settlement": "unsure",
  "Investment": "business",
  "Religious/missionary work": "unsure",
  "Refuge/asylum/protection": "unsure",
  "I am not sure yet": "unsure",
  "Other": "unsure",
};
export function migrationObjectiveFor(reason) {
  return MIGRATION_REASON_TO_OBJECTIVE[reason] || "unsure";
}
export const ASYLUM_REASON = "Refuge/asylum/protection";

const HAS_DESTINATION_OPTIONS = ["Yes", "No", "I have several countries in mind", "I'm open to recommendations"];
const HAS_DESTINATION_CODES = ["yes", "no", "several", "open"];

const DESTINATION_FLEXIBILITY_OPTIONS = [
  "Very flexible — recommend the best options for me", "Somewhat flexible", "I have a preferred country", "I only want this country",
];
const DESTINATION_FLEXIBILITY_CODES = ["very_flexible", "somewhat_flexible", "preferred_country", "only_this_country"];

export const DESTINATION_PRIORITY_OPTIONS = [
  "Employment opportunities", "Salary/income potential", "Permanent residence", "Citizenship pathway",
  "Affordable living", "Education", "Safety/security", "Healthcare", "Family friendliness",
  "Climate/weather", "Business opportunities", "English-speaking environment", "Community/diaspora",
  "Quality of life", "Low migration costs", "Fastest pathway", "Other",
];

export const MIGRATION_CONCERN_OPTIONS = [
  "Cost", "Visa eligibility", "Finding a job", "Finding accommodation", "Leaving family behind",
  "Language", "Safety", "Getting documents", "Scam/fraud risk", "Uncertainty about the process",
  "Whether I qualify", "Other",
];

const BUDGET_OPTIONS = [
  "Under ₦1 million", "₦1–3 million", "₦3–5 million", "₦5–10 million", "₦10–20 million", "Above ₦20 million", "I'm not sure yet",
];

const FUNDING_SOURCE_OPTIONS = [
  "Personal savings", "Employment income", "Family support", "Scholarship", "Employer sponsorship",
  "Loan", "Business/investment funds", "Combination", "Not sure",
];

const WANTS_NAVIGATE_OPTIONS = ["Yes — Take me to MIGRA Navigate", "Maybe later"];
const WANTS_NAVIGATE_CODES = ["yes", "maybe_later"];

export const DISCOVER_SECTIONS = [
  // --- 1. About You --- (full name / current country / current region reuse User fields)
  question("date_of_birth", "What is your date of birth? (e.g. 15/04/1995)", dateParser),
  question("gender", "What is your gender?", textParser, ["Male", "Female", "Prefer not to say"], { allowSkip: true }),
  question("country", "Which country are you currently living in?", textParser, [], { target: "user" }),
  question("state", "What city/state/region do you currently live in?", textParser, [], { target: "user" }),
  question("nationality", "What is your nationality?"),
  question("other_citizenship_or_pr", "Do you currently hold any other citizenship or permanent residence? (If none, reply No)"),
  question("language_ability", "What languages do you speak?"),
  question("preferred_language", "What is your preferred language for communicating with MIGRA?"),

  // --- 2. What Are You Trying to Achieve ---
  question("migration_reason", "What is your main reason for considering migration?", textParser, MIGRATION_REASON_OPTIONS),
  question(
    "asylum_context_detail",
    "If you're comfortable sharing, is there anything else about your situation you'd like MIGRA " +
      "to know? This is entirely optional, and a specialist will treat it with care. (Reply skip to leave this out)",
    textParser, [],
    { skipIf: (p) => p.migration_reason !== ASYLUM_REASON, allowSkip: true }
  ),
  question(
    "migration_goal_detail",
    'What would you ideally like to achieve by moving? (e.g. "I want to get a job as a nurse in Canada and eventually settle there.")'
  ),

  // --- 3. Where Do You Want to Go ---
  question("has_destination_in_mind", "Do you already have a destination in mind?", makeOptionParser(HAS_DESTINATION_OPTIONS, HAS_DESTINATION_CODES), HAS_DESTINATION_OPTIONS),
  question("destination_countries", "Which country or countries are you considering?", textParser, [],
    { skipIf: (p) => p.has_destination_in_mind === "no" || p.has_destination_in_mind === "open" }),
  question("destination_interest_reason", "Why are you interested in this country/countries?", textParser, [],
    { skipIf: (p) => p.has_destination_in_mind === "no" || p.has_destination_in_mind === "open" }),
  question("destination_flexibility", "How flexible are you about your destination?",
    makeOptionParser(DESTINATION_FLEXIBILITY_OPTIONS, DESTINATION_FLEXIBILITY_CODES), DESTINATION_FLEXIBILITY_OPTIONS),

  // --- 4. Education & Professional Profile ---
  question("education", "What is your highest level of education?", textParser,
    ["Secondary", "Diploma", "Bachelor's", "Master's", "PhD", "Professional qualification", "Other"]),
  question("field_of_study", "What did you study?"),
  question("institution", "What institution did you attend?"),
  question("graduation_year", "When did you graduate? (year, e.g. 2020)", intParser),
  question("certifications", "Do you have any professional certifications or licences? (If none, reply No)"),
  question("occupation", "What is your current occupation?"),
  question("job_title", "What is your job title?"),
  question("experience_years", "How many years of professional/work experience do you have?", intParser),
  question("industries", "What industries have you worked in?"),
  question("key_skills", "What are your key skills?"),
  question("employment_status", "Are you currently employed?", yesNoParser, ["Yes", "No"]),
  question("employment_type", "What type of employment do you have?", textParser,
    ["Full-time", "Part-time", "Self-employed", "Business owner", "Freelancer", "Unemployed", "Student", "Other"]),
  question("income_range", "What is your current annual/monthly income range?", textParser, [], { allowSkip: true }),

  // --- 5. Migration Readiness ---
  question("travelled_before", "Have you travelled outside your country before?", yesNoParser, ["Yes", "No"]),
  question("travel_history", 'Which countries, for what purpose, and how long did you stay? (e.g. "UK, tourism, 2 weeks")', textParser, [],
    { skipIf: skipUnless("travelled_before") }),
  question("returned_on_time", "Did you return before your visa/status expired?", yesNoParser, ["Yes", "No"],
    { skipIf: skipUnless("travelled_before") }),
  question("visa_applied_before", "Have you ever applied for a visa?", yesNoParser, ["Yes", "No"]),
  question("visa_type_applied", "What type of visa did you apply for?", textParser, [],
    { skipIf: skipUnless("visa_applied_before") }),
  question("visa_refused_before", "Have you ever had a visa application refused or denied?", yesNoParser, ["Yes", "No"],
    { skipIf: skipUnless("visa_applied_before") }),
  question("visa_refusal_country", "Which country?", textParser, [], { skipIf: skipUnless("visa_refused_before") }),
  question("visa_refusal_type", "What type of visa?", textParser, [], { skipIf: skipUnless("visa_refused_before") }),
  question("visa_refusal_when", "Approximately when?", textParser, [], { skipIf: skipUnless("visa_refused_before") }),
  question("visa_refusal_reason", "Do you know the reason for the refusal? (If you'd rather not say, reply skip)", textParser, [],
    { skipIf: skipUnless("visa_refused_before"), allowSkip: true }),

  // --- 6. Family & Dependants ---
  question("migrating_with", "Are you planning to migrate alone or with family?", textParser,
    ["Alone", "Spouse/partner", "Children", "Parents", "Other family members", "Not sure yet"]),
  question("marital_status", "What is your marital/relationship status?"),
  question("has_dependents", "Do you have children/dependents?", yesNoParser, ["Yes", "No"]),
  question("dependents_count", "How many?", intParser, [], { skipIf: skipUnless("has_dependents") }),
  question("dependents_ages", "What are their approximate age ranges?", textParser, [], { skipIf: skipUnless("has_dependents") }),
  question("dependents_migrating", "Will they migrate with you?", yesNoParser, ["Yes", "No"], { skipIf: skipUnless("has_dependents") }),
  question("family_abroad", "Do you have close family members already living abroad?", yesNoParser, ["Yes", "No"]),
  question("family_abroad_country", "Which country?", textParser, [], { skipIf: skipUnless("family_abroad") }),
  question("family_abroad_relationship", "What is their relationship to you?", textParser, [], { skipIf: skipUnless("family_abroad") }),
  question("family_abroad_status", "What is their immigration/residency status, if known?", textParser, [], { skipIf: skipUnless("family_abroad") }),

  // --- 7. Financial & Practical Capacity ---
  question("financial_readiness", "What is your approximate budget for your migration journey?", textParser, BUDGET_OPTIONS),
  question("funding_source", "How do you expect to fund your migration?", textParser, FUNDING_SOURCE_OPTIONS),
  question("timeline", "How soon would you ideally like to move?", timelineParser, TIMELINE_OPTIONS),

  // --- 8. Preferences & Constraints ---
  question(
    "destination_priorities",
    "What matters most to you in choosing a destination? Reply with the numbers that matter most " +
      "to you, separated by commas (e.g. 1,3,5).",
    multiParser(DESTINATION_PRIORITY_OPTIONS), DESTINATION_PRIORITY_OPTIONS
  ),
  question(
    "migration_concerns",
    "What are your biggest concerns about migrating? Reply with the numbers, separated by commas.",
    multiParser(MIGRATION_CONCERN_OPTIONS), MIGRATION_CONCERN_OPTIONS
  ),

  // --- Final questions ---
  question("biggest_question", "What is the biggest question you want MIGRA to answer for you?"),
  question(
    "confidence_level",
    "How confident are you about your migration plan today?\n" +
      "1 — I have no idea where to start\n2 — I have some ideas\n3 — I understand some of my options\n" +
      "4 — I have a fairly clear plan\n5 — I know exactly what I need to do",
    confidenceParser
  ),
  question("wants_navigate", "Would you like MIGRA to analyse your profile more deeply and help you build a personalised migration pathway?",
    makeOptionParser(WANTS_NAVIGATE_OPTIONS, WANTS_NAVIGATE_CODES), WANTS_NAVIGATE_OPTIONS),
];

export const CONSULTATION_MENU_OPTIONS = ["Book Consultation", "Talk to an Expert Now", "Continue Later"];

export const MAIN_MENU_OPTIONS = [
  "Explore Migration Options",
  "Check My Eligibility",
  "Work Abroad",
  "Study Abroad",
  "Family Migration",
  "Migration Costs",
  "Required Documents",
  "Speak to an Expert",
  "Track My Application",
  "FAQs",
  "Resources",
];
