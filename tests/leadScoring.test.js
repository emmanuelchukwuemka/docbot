import { describe, expect, test } from "@jest/globals";
import { scoreLead } from "../src/leads/scoring.js";

describe("lead scoring", () => {
  test("empty profile scores 0 and classifies COLD", () => {
    const result = scoreLead({ profile: null });
    expect(result.score).toBe(0);
    expect(result.classification).toBe("COLD");
  });

  test("strong profile with suitable assessment classifies HOT", () => {
    const result = scoreLead({
      profile: {
        destination_country: "Canada",
        migration_objective: "work",
        timeline: "within_3_months",
        financial_readiness: "ready",
      },
      latestEligibility: { result: "potentially_suitable" },
      requestedConsultation: true,
    });
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.classification).toBe("HOT");
  });

  test("score is clamped to [0, 100]", () => {
    const result = scoreLead({
      profile: {
        destination_country: "Canada",
        migration_objective: "work",
        timeline: "within_3_months",
        financial_readiness: "ready",
      },
      latestEligibility: { result: "potentially_suitable" },
      documents: [{ status: "verified" }, { status: "verified" }],
      requiredDocumentCount: 2,
      messageCount: 90,
      requestedConsultation: true,
    });
    expect(result.score).toBeLessThanOrEqual(100);
  });

  test("mid-range profile classifies WARM", () => {
    const result = scoreLead({
      profile: { destination_country: "Germany", migration_objective: "study", timeline: "within_3_months" },
    });
    expect(result.score).toBe(45);
    expect(result.classification).toBe("WARM");
  });
});
