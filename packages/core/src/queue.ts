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
