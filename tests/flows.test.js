import { describe, expect, test } from "@jest/globals";
import { FLOWS, TIMELINE_CODES } from "../src/conversation/flows.js";

describe("conversation flow question parsers", () => {
  test("work flow asks destination, age, occupation, experience, education, job offer, registration, timeline in order", () => {
    const fieldNames = FLOWS.work.map((q) => q.field_name);
    expect(fieldNames).toEqual([
      "destination_country",
      "age",
      "occupation",
      "experience_years",
      "education",
      "job_offer_status",
      "professional_registration",
      "timeline",
    ]);
  });

  test("job_offer_status and professional_registration parse yes/no answers", () => {
    const jobOffer = FLOWS.work.find((f) => f.field_name === "job_offer_status");
    expect(jobOffer.parser("Yes")).toBe(true);
    expect(jobOffer.parser("no")).toBe(false);
    expect(jobOffer.parser("maybe")).toBeNull();

    const registration = FLOWS.work.find((f) => f.field_name === "professional_registration");
    expect(registration.parser("N/A")).toBe(false);
    expect(registration.parser("Yes")).toBe(true);
  });

  test("experience_years parser extracts an integer from free text", () => {
    const q = FLOWS.work.find((f) => f.field_name === "experience_years");
    expect(q.parser("about 5 years")).toBe(5);
    expect(q.parser("none yet")).toBeNull();
  });

  test("timeline parser matches option text or numeric index", () => {
    const q = FLOWS.work.find((f) => f.field_name === "timeline");
    expect(q.parser("Within 3 months")).toBe(TIMELINE_CODES[0]);
    expect(q.parser("2")).toBe(TIMELINE_CODES[1]);
    expect(q.parser("whenever")).toBeNull();
  });
});
