import { describe, expect, test } from "@jest/globals";
import { detectEscalationReason } from "../src/conversation/escalation.js";

describe("escalation detection", () => {
  test("does NOT escalate on a bare human-agent request (routine trigger, removed 2026-08-28)", () => {
    expect(detectEscalationReason("I want to talk to a human", null)).toBeNull();
    expect(detectEscalationReason("ok sure", { wants_human_agent: true })).toBeNull();
  });

  test("does NOT escalate on menu option 'Speak to a specialist'", () => {
    expect(detectEscalationReason("Speak to a specialist", null)).toBeNull();
  });

  test("detects fraud report keywords", () => {
    expect(detectEscalationReason("I think I got scammed by a fake agent", null)).toMatch(/suspicious/);
  });

  test("detects legal keywords", () => {
    expect(detectEscalationReason("I need a lawyer for this", null)).toMatch(/legal/);
  });

  test("detects an explicit complaint", () => {
    expect(detectEscalationReason("this is unacceptable service", { intent: "complaint" })).toMatch(/complaint/i);
  });

  test("detects visa refusal and immigration violation mentions", () => {
    expect(detectEscalationReason("my visa was refused last year", null)).toMatch(/refusal/i);
    expect(detectEscalationReason("I overstayed my last visa", null)).toMatch(/violation/i);
  });

  test("detects sensitive family circumstances", () => {
    expect(detectEscalationReason("my husband passed away last year", null)).toMatch(/family/);
    expect(detectEscalationReason("I'm going through a divorce", null)).toMatch(/family/);
  });

  test("detects document concerns", () => {
    expect(detectEscalationReason("I lost my passport", null)).toMatch(/document/i);
    expect(detectEscalationReason("my document was rejected", null)).toMatch(/document/i);
  });

  test("does NOT escalate on ordinary confused-sounding free text (no fallback-count trigger anymore)", () => {
    expect(detectEscalationReason("asdkjasd", null)).toBeNull();
    expect(detectEscalationReason("hi", null)).toBeNull();
  });
});
