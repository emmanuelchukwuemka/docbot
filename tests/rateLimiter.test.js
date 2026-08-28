import { describe, expect, test } from "@jest/globals";
import { RateLimiter } from "../src/security/rateLimiter.js";

describe("RateLimiter", () => {
  test("allows up to max hits within the window, then blocks", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 10_000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
  });

  test("tracks each key independently", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 10_000 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
  });

  test("allows hits again once the window has fully elapsed", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 20 });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("a")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(limiter.consume("a")).toBe(true);
  });

  test("retryAfterMs reports 0 when allowed and >0 once blocked", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 10_000 });
    expect(limiter.retryAfterMs("a")).toBe(0);
    limiter.consume("a");
    expect(limiter.retryAfterMs("a")).toBeGreaterThan(0);
  });

  test("sweep drops keys with no hits left in the window", async () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 20 });
    limiter.consume("a");
    expect(limiter.hits.has("a")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    limiter.sweep();
    expect(limiter.hits.has("a")).toBe(false);
  });

  test("defaults to a shared '_global' key when none is given", () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 10_000 });
    expect(limiter.consume()).toBe(true);
    expect(limiter.consume()).toBe(false);
  });
});
