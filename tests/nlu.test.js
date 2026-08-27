import { describe, expect, test } from "@jest/globals";
import { extractedEntitiesFromDict } from "../src/ai/nlu.js";

describe("nlu entity extraction shaping", () => {
  test("fills defaults for missing fields", () => {
    const entities = extractedEntitiesFromDict({ intent: "work", confidence: 0.9, wants_human_agent: false });
    expect(entities.intent).toBe("work");
    expect(entities.destination_country).toBeNull();
    expect(entities.wants_human_agent).toBe(false);
  });

  test("passes through known fields and ignores unknown ones", () => {
    const entities = extractedEntitiesFromDict({
      intent: "work",
      confidence: 0.7,
      wants_human_agent: false,
      destination_country: "Canada",
      unexpected_field: "ignored",
    });
    expect(entities.destination_country).toBe("Canada");
    expect(entities.unexpected_field).toBeUndefined();
  });
});
