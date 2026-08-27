import { describe, expect, test } from "@jest/globals";
import { detectEscalationReason, FALLBACK_ESCALATION_THRESHOLD } from "../src/conversation/escalation.js";

describe("escalation detection", () => {
  test("detects explicit human agent request", () => {
    expect(detectEscalationReason("I want to talk to a human", null, 0)).toMatch(/human agent/);
  });

  test("does not escalate on menu option 'Speak to a specialist'", () => {
    expect(detectEscalationReason("Speak to a specialist", null, 0)).toBeNull();
  });

  test("detects fraud report keywords", () => {
    expect(detectEscalationReason("I think I got scammed by a fake agent", null, 0)).toMatch(/suspicious/);
  });

  test("detects legal keywords", () => {
    expect(detectEscalationReason("I need a lawyer for this", null, 0)).toMatch(/legal/);
  });

  test("escalates after repeated fallback failures", () => {
    expect(detectEscalationReason("asdkjasd", null, FALLBACK_ESCALATION_THRESHOLD)).toMatch(/confused/);
    expect(detectEscalationReason("asdkjasd", null, FALLBACK_ESCALATION_THRESHOLD - 1)).toBeNull();
  });

  test("escalates when NLU extraction reports wants_human_agent", () => {
    expect(detectEscalationReason("ok sure", { wants_human_agent: true }, 0)).toMatch(/human agent/);
  });

  test("detects sensitive family circumstances", () => {
    expect(detectEscalationReason("my husband passed away last year", null, 0)).toMatch(/family/);
    expect(detectEscalationReason("I'm going through a divorce", null, 0)).toMatch(/family/);
  });

  test("detects document concerns", () => {
    expect(detectEscalationReason("I lost my passport", null, 0)).toMatch(/document/i);
    expect(detectEscalationReason("my document was rejected", null, 0)).toMatch(/document/i);
  });
});
