import crypto from "node:crypto";
import { describe, expect, test } from "@jest/globals";
import { settings } from "../src/config.js";
import { verifyWebhookSignature } from "../src/payments/paystackClient.js";

// Overridden directly (settings is a plain exported object) so this test is deterministic
// regardless of whatever real Paystack key .env happens to have loaded.
settings.paystackSecretKey = "test-secret-key";

function sign(bodyBuffer) {
  return crypto.createHmac("sha512", settings.paystackSecretKey).update(bodyBuffer).digest("hex");
}

describe("Paystack webhook signature verification", () => {
  test("accepts a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ event: "charge.success" }));
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  test("rejects a body that doesn't match the signature", () => {
    const body = Buffer.from(JSON.stringify({ event: "charge.success" }));
    const signatureForADifferentBody = sign(Buffer.from(JSON.stringify({ event: "charge.failed" })));
    expect(verifyWebhookSignature(body, signatureForADifferentBody)).toBe(false);
  });

  test("rejects a missing signature header", () => {
    expect(verifyWebhookSignature(Buffer.from("{}"), undefined)).toBe(false);
  });

  test("rejects a malformed/wrong-length signature without throwing", () => {
    expect(() => verifyWebhookSignature(Buffer.from("{}"), "not-a-real-signature")).not.toThrow();
    expect(verifyWebhookSignature(Buffer.from("{}"), "not-a-real-signature")).toBe(false);
  });

  test("returns false when no secret key is configured", () => {
    const original = settings.paystackSecretKey;
    settings.paystackSecretKey = "";
    const body = Buffer.from("{}");
    expect(verifyWebhookSignature(body, "anything")).toBe(false);
    settings.paystackSecretKey = original;
  });
});
