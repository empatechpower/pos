import { evaluateWindows, localParts, windowsFor, zonedToEpoch, DEFAULT_TIME_ZONE, type MenuWindows, type WindowSlot } from "./windows.js";

/** What the server needs to say which pickup times an outlet offers. */
export interface SlotConfig {
  now: number;
  timeZone?: string;
  /** The outlet's menu windows. */
  windows?: MenuWindows;
  /** The items in the order (ids and categories), so every item's own window must be open. Empty = the menu's windows only. */
  items?: readonly { id: string; category: string }[];
  prepMinutes: number;
  /** Slots fall on multiples of this many minutes of the wall clock. */
  intervalMinutes: number;
  /** Furthest day ahead that can be picked (0 = today only). */
  daysAhead: number;
}

const DAY = 86_400_000;

/** The window sets that all have to be open at a pickup time: one per item rule, or the menu's own. */
function windowSets(cfg: SlotConfig): (readonly WindowSlot[] | undefined)[] {
  const items = cfg.items ?? [];
  if (!items.length) return [cfg.windows?.menu?.length ? cfg.windows.menu : undefined];
  return items.map((p) => windowsFor(cfg.windows, p));
}

/** Is this instant a valid pickup: on the interval, after now plus prep, within the days ahead, and inside every item's window. */
export function isValidSlot(t: number, cfg: SlotConfig): boolean {
  const tz = cfg.timeZone ?? DEFAULT_TIME_ZONE;
  if (!Number.isFinite(t) || t < cfg.now + cfg.prepMinutes * 60_000) return false;
  const l = localParts(t, tz);
  if (l.minutes % cfg.intervalMinutes !== 0) return false;
  const today = localParts(cfg.now, tz);
  const dayIndex = Math.round((Date.UTC(l.y, l.m - 1, l.d) - Date.UTC(today.y, today.m - 1, today.d)) / DAY);
  if (dayIndex < 0 || dayIndex > cfg.daysAhead) return false;
  return windowSets(cfg).every((s) => {
    const e = evaluateWindows(s, t, tz);
    return e.open && (e.closesAt === undefined || t < e.closesAt);
  });
}

/** The pickup times of one calendar day (`date` = "YYYY-MM-DD" in the outlet's time zone), earliest first. */
export function pickupSlots(date: string, cfg: SlotConfig): number[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return [];
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const tz = cfg.timeZone ?? DEFAULT_TIME_ZONE;
  const out: number[] = [];
  for (let min = 0; min < 1440; min += cfg.intervalMinutes) {
    const t = zonedToEpoch(y, mo, d, min, tz);
    const l = localParts(t, tz);
    if (l.y !== y || l.m !== mo || l.d !== d) continue; // a daylight-saving gap
    if (isValidSlot(t, cfg)) out.push(t);
  }
  return out;
}
