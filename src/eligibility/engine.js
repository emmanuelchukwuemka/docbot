// FR-04 Eligibility Pre-Screening.
//
// Deliberately NOT a hardcoded "must have N years experience" rule engine — the PRD's AI
// guardrails (section 26) say the system must "never fabricate immigration requirements."
// Instead this checks two things, both traceable to real data rather than invented rules:
//
// 1. Completeness — has the user given us enough profile information for this pathway
//    category to say anything meaningful yet?
// 2. Fit against the pathway's own `eligibility_criteria` (sourced from the knowledge base,
//    see PRD section 13 — each pathway record carries its own source/verification trail).
//
// The output is always framed as "potentially suitable" / "more information required" /
// "likely not suitable", per FR-04's exact wording, and is never presented as a final
// decision (see EligibilityResult.disclaimer).

export const REQUIRED_FIELDS_BY_CATEGORY = {
  work: ["destination_country", "occupation", "education", "experience_years"],
  study: ["destination_country", "education"],
  family: ["destination_country", "family_status"],
  business: ["destination_country", "occupation", "financial_readiness"],
  visit: ["destination_country"],
};
const DEFAULT_REQUIRED_FIELDS = ["destination_country"];

export const EligibilityResultType = Object.freeze({
  POTENTIALLY_SUITABLE: "potentially_suitable",
  MORE_INFORMATION_REQUIRED: "more_information_required",
  LIKELY_NOT_SUITABLE: "likely_not_suitable",
});

const RESULT_MESSAGES = {
  [EligibilityResultType.POTENTIALLY_SUITABLE]:
    "Based on the information you've provided, you may have a potentially suitable " +
    "profile for this pathway.",
  [EligibilityResultType.MORE_INFORMATION_REQUIRED]:
    "We need additional information before we can determine whether this pathway " +
    "may be suitable.",
  [EligibilityResultType.LIKELY_NOT_SUITABLE]:
    "Based on the information provided, this pathway may not currently be suitable. " +
    "We can explore alternative pathways with you.",
};

export const DISCLAIMER =
  "This is a preliminary, automated indication only — not an official immigration " +
  "decision. A MigraTech specialist can review your full circumstances.";

function missingRequiredFields(profile, category) {
  const required = REQUIRED_FIELDS_BY_CATEGORY[category] || DEFAULT_REQUIRED_FIELDS;
  return required.filter((fieldName) => !profile[fieldName]);
}

/** Returns a list of red-flag reasons if the profile conflicts with pathway criteria that
 * the user HAS given us data for. Silent (no flag) when we lack the data to judge. */
function checkPathwayCriteria(profile, pathway) {
  const flags = [];
  const criteria = pathway.eligibility_criteria || {};

  if (criteria.job_offer_required === true && profile.job_offer_status === false) {
    flags.push("This pathway typically requires a job offer, which you've indicated you don't have yet.");
  }

  const minAge = criteria.min_age;
  if (typeof minAge === "number" && profile.age != null && profile.age < minAge) {
    flags.push(`This pathway typically requires a minimum age of ${minAge}.`);
  }

  const minExperience = criteria.experience_years_min;
  if (
    typeof minExperience === "number" &&
    profile.experience_years != null &&
    profile.experience_years < minExperience
  ) {
    flags.push(`This pathway typically expects at least ${minExperience} years of relevant experience.`);
  }

  return flags;
}

export function assess(profile, pathway) {
  const category = pathway.category;
  const missing = missingRequiredFields(profile, category);

  if (missing.length >= 2) {
    return {
      result: EligibilityResultType.MORE_INFORMATION_REQUIRED,
      message: RESULT_MESSAGES[EligibilityResultType.MORE_INFORMATION_REQUIRED],
      missing_fields: missing,
      reasons: ["We still need a few more details to assess this pathway."],
      disclaimer: DISCLAIMER,
    };
  }

  const redFlags = checkPathwayCriteria(profile, pathway);
  if (redFlags.length) {
    return {
      result: EligibilityResultType.LIKELY_NOT_SUITABLE,
      message: RESULT_MESSAGES[EligibilityResultType.LIKELY_NOT_SUITABLE],
      missing_fields: missing,
      reasons: redFlags,
      disclaimer: DISCLAIMER,
    };
  }

  if (missing.length) {
    return {
      result: EligibilityResultType.MORE_INFORMATION_REQUIRED,
      message: RESULT_MESSAGES[EligibilityResultType.MORE_INFORMATION_REQUIRED],
      missing_fields: missing,
      reasons: [`We're missing: ${missing.join(", ")}.`],
      disclaimer: DISCLAIMER,
    };
  }

  const reasons = [];
  if (profile.education) reasons.push(`You have indicated: ${profile.education}.`);
  if (profile.experience_years) reasons.push(`You have ${profile.experience_years} years of relevant experience.`);
  if (profile.occupation) reasons.push(`Your occupation (${profile.occupation}) may be eligible.`);
  if (!reasons.length) reasons.push("Your profile meets the basic information requirements for this pathway.");

  return {
    result: EligibilityResultType.POTENTIALLY_SUITABLE,
    message: RESULT_MESSAGES[EligibilityResultType.POTENTIALLY_SUITABLE],
    missing_fields: [],
    reasons,
    disclaimer: DISCLAIMER,
  };
}
