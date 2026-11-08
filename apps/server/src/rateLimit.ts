/**
 * Counts failures per key (here: client IP) in a sliding window. In memory, so it resets on restart
 * and is per server instance; move it to Redis when there is more than one instance.
 */
export class FailureLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }
  fail(key: string, now = Date.now()) {
    this.hits.set(key, [...this.recent(key, now), now]);
  }
  private recent(key: string, now: number) {
    const live = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (live.length) this.hits.set(key, live);
    else this.hits.delete(key);
    return live;
  }
}
