// FR-02 Migration Goal Assessment / FR-03 Destination Discovery.
//
// Defines, per migration-goal category, the ordered set of profile fields the bot still
// needs to ask about. ConversationManager walks this list and skips any field the profile
// already has a value for.

function textParser(text) {
  const trimmed = text.trim();
  return trimmed || null;
}

function intParser(text) {
  const match = text.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

const YES_WORDS = new Set(["yes", "y", "yeah", "yep", "yup"]);
const NO_WORDS = new Set(["no", "n", "nope", "not applicable", "n/a", "na", "none"]);
function yesNoParser(text) {
  const lowered = text.trim().toLowerCase();
  if (YES_WORDS.has(lowered)) return true;
  if (NO_WORDS.has(lowered)) return false;
  return null;
}

export const TIMELINE_OPTIONS = ["Within 3 months", "3–6 months", "6–12 months", "More than 12 months"];
export const TIMELINE_CODES = ["within_3_months", "3_6_months", "6_12_months", "more_than_12_months"];

function timelineParser(text) {
  const lowered = text.toLowerCase();
  for (let i = 0; i < TIMELINE_OPTIONS.length; i++) {
    if (lowered.includes(TIMELINE_OPTIONS[i].toLowerCase())) return TIMELINE_CODES[i];
  }
  const match = text.match(/\d+/);
  if (match) {
    const idx = parseInt(match[0], 10) - 1;
    if (idx >= 0 && idx < TIMELINE_CODES.length) return TIMELINE_CODES[idx];
  }
  return null;
}

function question(fieldName, prompt, parser = textParser, options = []) {
  return { field_name: fieldName, prompt, parser, options };
}

export const GOAL_OPTIONS = ["Work", "Study", "Join Family", "Start a Business", "Visit", "I'm not sure"];
export const GOAL_CODES = ["work", "study", "family", "business", "visit", "unsure"];

export const FLOWS = {
  work: [
    question("destination_country", "Which country are you interested in?"),
    question("age", "How old are you?", intParser),
    question("occupation", "What is your occupation?"),
    question("experience_years", "How many years of professional experience do you have?", intParser),
    question("education", "What is your highest educational qualification?"),
    question(
      "job_offer_status",
      "Do you already have a job offer for this role? (Yes/No)",
      yesNoParser,
      ["Yes", "No"]
    ),
    question(
      "professional_registration",
      "Do you hold a professional license or registration relevant to your occupation, " +
        "if applicable? (Yes/No)",
      yesNoParser,
      ["Yes", "No"]
    ),
    question(
      "timeline",
      "One final question for this preliminary assessment: how soon would you " +
        "ideally like to relocate?",
      timelineParser,
      TIMELINE_OPTIONS
    ),
  ],
  study: [
    question("destination_country", "Which country are you interested in studying in?"),
    question("age", "How old are you?", intParser),
    question(
      "education",
      "What level of study are you interested in? (e.g. Undergraduate, Master's, " +
        "PhD, Professional qualification)"
    ),
    question("timeline", "How soon would you like to start?", timelineParser, TIMELINE_OPTIONS),
  ],
  family: [
    question("destination_country", "Which country is your family member/spouse in?"),
    question("age", "How old are you?", intParser),
    question(
      "family_status",
      "Tell me a bit about your situation — for example, joining a spouse, " +
        "reuniting with family, or relocating with children."
    ),
    question("timeline", "How soon would you like this to happen?", timelineParser, TIMELINE_OPTIONS),
  ],
  business: [
    question("destination_country", "Which country are you considering for business/investment?"),
    question("age", "How old are you?", intParser),
    question("occupation", "What type of business or investment are you considering?"),
    question(
      "financial_readiness",
      "What is your approximate available budget range for this (rough figure is fine)?"
    ),
    question("timeline", "How soon would you like to start this process?", timelineParser, TIMELINE_OPTIONS),
  ],
  visit: [question("destination_country", "Which country would you like to visit?")],
};

export const DESTINATION_DISCOVERY_OPTIONS = [
  "Employment opportunities",
  "Education",
  "Permanent residency prospects",
  "Family relocation",
  "Lower migration cost",
  "Faster processing",
  "Higher earning potential",
  "Business opportunities",
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
];
