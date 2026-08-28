// Generic in-memory sliding-window rate limiter, shared by the WhatsApp inbound/outbound
// guards and the AI call guard. It only answers "is this key allowed right now" — callers
// decide what to do when the answer is no (drop, skip, fall back), so the same class works
// for very different situations without knowing about WhatsApp or OpenAI at all.
//
// In-memory + single-process is a deliberate MVP limit, same as the node-cron scheduler
// (see scheduler.js) — fine for one instance, not something to rely on across replicas.

export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> timestamps within the trailing window
  }

  /** Records a hit for `key` and returns true if it's allowed under the limit, false if
   * `key` already has `max` hits within the trailing `windowMs`. Call once per attempt,
   * whether or not the caller ends up going through with it. */
  consume(key = "_global") {
    const timestamps = this._recentHits(key);
    if (timestamps.length >= this.max) {
      this.hits.set(key, timestamps);
      return false;
    }
    timestamps.push(Date.now());
    this.hits.set(key, timestamps);
    return true;
  }

  /** Ms until `key` would next be allowed, or 0 if it's allowed right now. */
  retryAfterMs(key = "_global") {
    const timestamps = this._recentHits(key);
    if (timestamps.length < this.max) return 0;
    return timestamps[0] + this.windowMs - Date.now();
  }

  _recentHits(key) {
    const cutoff = Date.now() - this.windowMs;
    return (this.hits.get(key) || []).filter((t) => t > cutoff);
  }

  /** Drops keys with no hits left in the trailing window, so long-lived processes don't
   * accumulate one Map entry per WhatsApp number/recipient forever. Cheap to call
   * periodically (see scheduler.js) rather than on every consume(). */
  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      const kept = timestamps.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}
