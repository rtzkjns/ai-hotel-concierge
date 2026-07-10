const WINDOW_MS = 60_000;
const MAX_TEXT_LENGTH = 4000;

/** Sliding-window per-key rate limiter (key = sender, e.g. conversation id). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly maxPerMinute = 20,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((hit) => hit > t - WINDOW_MS);
    if (recent.length === 0) this.hits.delete(key); // evict idle senders to bound memory
    if (recent.length >= this.maxPerMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}

/** Oversized messages or the same text repeated 3 times in a row count as spam. */
export function isSpam(recentUserTexts: string[], text: string): boolean {
  if (text.length > MAX_TEXT_LENGTH) return true;
  const lastThree = recentUserTexts.slice(-3);
  return lastThree.length === 3 && lastThree.every((t) => t === text);
}
