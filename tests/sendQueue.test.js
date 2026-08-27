import { describe, expect, test } from "@jest/globals";
import { SendQueue } from "../src/whatsapp/sendQueue.js";

describe("outbound send queue (WhatsApp rate limiting)", () => {
  test("runs sends serially, spaced at least minIntervalMs apart", async () => {
    const queue = new SendQueue(50);
    const timestamps = [];
    const record = () => {
      timestamps.push(Date.now());
      return Promise.resolve();
    };

    await Promise.all([queue.enqueue(record), queue.enqueue(record), queue.enqueue(record)]);

    expect(timestamps).toHaveLength(3);
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(45);
    expect(timestamps[2] - timestamps[1]).toBeGreaterThanOrEqual(45);
  });

  test("preserves enqueue order", async () => {
    const queue = new SendQueue(10);
    const order = [];
    await Promise.all([
      queue.enqueue(() => order.push(1)),
      queue.enqueue(() => order.push(2)),
      queue.enqueue(() => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("a rejected send does not block sends queued behind it", async () => {
    const queue = new SendQueue(10);
    const results = [];
    const first = queue.enqueue(() => Promise.reject(new Error("boom"))).catch((e) => e.message);
    const second = queue.enqueue(() => "ok");
    const [firstResult, secondResult] = await Promise.all([first, second]);
    results.push(firstResult, secondResult);
    expect(results).toEqual(["boom", "ok"]);
  });
});
