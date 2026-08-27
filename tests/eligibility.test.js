import { describe, expect, test } from "@jest/globals";
import { assess, EligibilityResultType } from "../src/eligibility/engine.js";

function pathway(overrides = {}) {
  return {
    category: "work",
    eligibility_criteria: {},
    ...overrides,
  };
}

describe("eligibility engine", () => {
  test("returns more_information_required when 2+ required fields are missing", () => {
    const result = assess({}, pathway());
    expect(result.result).toBe(EligibilityResultType.MORE_INFORMATION_REQUIRED);
    expect(result.missing_fields.length).toBeGreaterThanOrEqual(2);
  });

  test("flags a red flag when job offer is required but user has none", () => {
    const profile = {
      destination_country: "United Kingdom",
      occupation: "Nurse",
      education: "BSc Nursing",
      experience_years: 5,
      job_offer_status: false,
    };
    const result = assess(profile, pathway({ eligibility_criteria: { job_offer_required: true } }));
    expect(result.result).toBe(EligibilityResultType.LIKELY_NOT_SUITABLE);
    expect(result.reasons[0]).toMatch(/job offer/);
  });

  test("returns potentially_suitable when all required fields present and no red flags", () => {
    const profile = {
      destination_country: "Germany",
      occupation: "Engineer",
      education: "MSc",
      experience_years: 6,
    };
    const result = assess(profile, pathway());
    expect(result.result).toBe(EligibilityResultType.POTENTIALLY_SUITABLE);
    expect(result.missing_fields).toEqual([]);
  });

  test("silently skips criteria the profile has no data for (never fabricates)", () => {
    const profile = {
      destination_country: "Canada",
      occupation: "Chef",
      education: "Diploma",
      experience_years: 3,
    };
    const result = assess(profile, pathway({ eligibility_criteria: { min_age: 21 } }));
    expect(result.result).toBe(EligibilityResultType.POTENTIALLY_SUITABLE);
  });
});
