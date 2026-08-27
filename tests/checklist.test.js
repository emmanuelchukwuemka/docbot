import { describe, expect, test } from "@jest/globals";
import { generateChecklist, renderChecklistWhatsappText } from "../src/documents/checklist.js";

function pathway() {
  return {
    name: "Skilled Worker Route",
    country: { name: "Germany" },
    documents: ["Passport", "CV", "Academic certificates"],
  };
}

describe("document checklist", () => {
  test("all documents missing when none uploaded", () => {
    const checklist = generateChecklist(pathway(), []);
    expect(checklist.items).toHaveLength(3);
    expect(checklist.items.every((i) => i.status === "missing")).toBe(true);
  });

  test("reflects uploaded/verified status per document type (case-insensitive)", () => {
    const checklist = generateChecklist(pathway(), [
      { document_type: "passport", status: "verified" },
      { document_type: "CV", status: "uploaded" },
    ]);
    expect(checklist.items.find((i) => i.name === "Passport").status).toBe("verified");
    expect(checklist.items.find((i) => i.name === "CV").status).toBe("uploaded");
    expect(checklist.items.find((i) => i.name === "Academic certificates").status).toBe("missing");
  });

  test("renders WhatsApp text with emoji status markers", () => {
    const checklist = generateChecklist(pathway(), [{ document_type: "passport", status: "verified" }]);
    const text = renderChecklistWhatsappText(checklist);
    expect(text).toContain("Germany Skilled Worker Route");
    expect(text).toContain("✅ Passport");
    expect(text).toContain("⬜ CV");
  });
});
