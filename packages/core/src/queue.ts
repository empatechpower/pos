/**
 * Queue numbers must be issuable with no network, so there is no global counter.
 * Each device owns a short code (A, B, C...) and its own daily counter: "A042".
 * Two offline tablets can never issue the same number.
 */
export function formatQueueNumber(deviceCode: string, counter: number): string {
  return `${deviceCode}${String(counter).padStart(3, "0")}`;
}

/** Next counter for this device on this business day, given numbers already issued today. */
export function nextQueueCounter(deviceCode: string, issuedToday: readonly string[]): number {
  let max = 0;
  for (const n of issuedToday) {
    if (!n.startsWith(deviceCode)) continue;
    const c = Number(n.slice(deviceCode.length));
    if (Number.isFinite(c) && c > max) max = c;
  }
  return max + 1;
}

/**
 * Collection number for an order that has a phone number (spec 11.2): the last 4 digits, no prefix.
 * If another active order already holds it, try base+A, base+B... and take the first free one, so a
 * number freed by a completed order is reused. Returns undefined when there are fewer than 8 digits.
 */
export function collectionNumber(phone: string | undefined, taken: ReadonlySet<string>): string | undefined {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (digits.length < 8) return undefined;
  const base = digits.slice(-4);
  if (!taken.has(base)) return base;
  for (let i = 0; i < 26; i++) {
    const c = `${base}${String.fromCharCode(65 + i)}`;
    if (!taken.has(c)) return c;
  }
  return undefined;
}
