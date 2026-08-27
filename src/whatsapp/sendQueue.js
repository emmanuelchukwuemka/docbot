// Serializes every outbound WhatsApp send through one choke point with a minimum delay
// (+ jitter) between messages. WhatsApp is more likely to flag/ban an unofficial (Baileys)
// client that sends in tight, machine-regular bursts — this smooths both normal
// conversation replies and bulk sends (e.g. the scheduler's reminder job, which loops over
// many leads) through the same limiter, so no call site has to think about pacing itself.

import { settings } from "../config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SendQueue {
  constructor(minIntervalMs = settings.whatsappMinSendIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.tail = Promise.resolve();
    this.lastSentAt = 0;
  }

  /** Runs `fn` once this send's turn comes up, after waiting out whatever's left of the
   * minimum interval since the last send. Every public WhatsAppClient send method should
   * call this exactly once per logical outbound message — never enqueue from inside an
   * already-enqueued task (that chains a promise onto itself and deadlocks). */
  enqueue(fn) {
    const run = this.tail.then(async () => {
      const wait = this.lastSentAt + this._nextDelay() - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastSentAt = Date.now();
      return fn();
    });
    // A failed send must not jam the queue for messages behind it.
    this.tail = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  _nextDelay() {
    return this.minIntervalMs + Math.random() * this.minIntervalMs * 0.5;
  }
}
