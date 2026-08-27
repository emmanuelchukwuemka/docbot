import { describe, expect, test } from "@jest/globals";
import { findBannedClaim, passesConfidenceThreshold } from "../src/ai/guardrails.js";

describe("AI guardrails", () => {
  test("catches a visa guarantee claim", () => {
    expect(findBannedClaim("We guarantee you a visa within 3 months")).not.toBeNull();
  });

  test("catches a 100% success claim", () => {
    expect(findBannedClaim("This pathway has a 100% success rate")).not.toBeNull();
  });

  test("does not flag ordinary, hedged guidance", () => {
    expect(findBannedClaim("This pathway may be a good fit based on your profile")).toBeNull();
  });

  test("confidence threshold respects config default (0.6)", () => {
    expect(passesConfidenceThreshold(0.8)).toBe(true);
    expect(passesConfidenceThreshold(0.4)).toBe(false);
  });
});
