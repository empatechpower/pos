/**
 * Menu time windows (backend handout, section 6). A menu is orderable only inside its WINDOWS, which are independent of the outlet's opening hours
 * (an outlet can be open all day while its menu sells Friday 11:00-20:30). Windows are set per menu, per category or per item, per day of the week;
 * the most specific one applies. Times are the outlet's own clock (its time zone), and a window whose end is not after its start runs past midnight.
 *
 * Pure: the same calls run on the server and on a device. No window defined anywhere = always inside the window.
 */

/** One window on one weekday. `day` is 0 = Sunday ... 6 = Saturday. Times are "HH:MM", and "24:00" means the end of that day. */
export interface WindowSlot {
  day: number;
  start: string;
  end: string;
}

export interface MenuWindows {
  /** The whole menu of the outlet. */
  menu?: WindowSlot[];
  /** Per category (the category name). Overrides the menu windows for its items. */
  categories?: Record<string, WindowSlot[]>;
  /** Per item (the product id). Overrides its category's. */
  products?: Record<string, WindowSlot[]>;
}

export const DEFAULT_TIME_ZONE = "Asia/Singapore";

export type AvailabilityState = "ORDERABLE" | "AVAILABLE_LATER" | "SOLD_OUT" | "OFF";

/** One computed state, with what a screen needs to explain it. */
export interface Availability {
  state: AvailabilityState;
  /** AVAILABLE_LATER: the window the item belongs to next, and when it opens (epoch ms). */
  window?: WindowSlot;
  nextOpeningAt?: number;
  /** ORDERABLE inside a window: when the window closes (epoch ms), so a screen can warn "last orders". */
  closesAt?: number;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const minutesOf = (t: string): number => (t === "24:00" ? 1440 : Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));

interface Local { y: number; m: number; d: number; day: number; minutes: number }

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The clock on the wall in a time zone at an instant. */
export function localParts(ms: number, timeZone: string): Local {
  let f = formatters.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }); formatters.set(timeZone, f); }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), day, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** The instant (epoch ms) at which a time zone's wall clock reads year-month-day plus `minutes`. */
export function zonedToEpoch(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes, 0);
  const off = (at: number) => { const l = localParts(at, timeZone); return Date.UTC(l.y, l.m - 1, l.d, 0, l.minutes) - at; };
  let t = guess - off(guess);
  t = guess - off(t); // once more: the offset can differ at a daylight-saving change
  return t;
}

interface Interval { start: number; end: number; slot: WindowSlot }

/** Every concrete interval of these slots from yesterday to a week ahead, so "now", "closes at" and "opens next" can all be read from it. */
function intervals(slots: readonly WindowSlot[], now: number, timeZone: string): Interval[] {
  const today = localParts(now, timeZone);
  const out: Interval[] = [];
  for (let back = -1; back <= 8; back++) {
    // calendar date `back` days from today, kept as a plain UTC date so adding days is exact
    const base = new Date(Date.UTC(today.y, today.m - 1, today.d + back));
    const dow = base.getUTCDay();
    for (const s of slots) {
      if (s.day !== dow) continue;
      const a = minutesOf(s.start);
      const b = minutesOf(s.end);
      const crosses = b <= a && s.end !== "24:00";
      const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate();
      const start = zonedToEpoch(y, m, d, a, timeZone);
      const end = crosses ? zonedToEpoch(y, m, d + 1, b, timeZone) : zonedToEpoch(y, m, d, b, timeZone);
      out.push({ start, end, slot: s });
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Where `now` stands against a set of windows. */
export function evaluateWindows(slots: readonly WindowSlot[] | undefined, now: number, timeZone: string = DEFAULT_TIME_ZONE): { open: boolean; closesAt?: number; current?: WindowSlot; nextOpenAt?: number; next?: WindowSlot } {
  if (!slots || slots.length === 0) return { open: true };
  const list = intervals(slots, now, timeZone);
  const cur = list.find((i) => i.start <= now && now < i.end);
  if (cur) {
    // a window that runs straight into the next one stays open until the last of them ends
    let end = cur.end;
    for (const i of list) if (i.start <= end && i.end > end) end = i.end;
    return { open: true, closesAt: end, current: cur.slot };
  }
  const nxt = list.find((i) => i.start > now);
  return nxt ? { open: false, nextOpenAt: nxt.start, next: nxt.slot } : { open: false };
}

/** The windows that apply to an item: its own, else its category's, else the menu's. undefined = none (always inside). */
export function windowsFor(w: MenuWindows | undefined, product: { id: string; category: string }): WindowSlot[] | undefined {
  if (!w) return undefined;
  const own = w.products?.[product.id];
  if (own?.length) return own;
  const cat = w.categories?.[product.category];
  if (cat?.length) return cat;
  return w.menu?.length ? w.menu : undefined;
}

/**
 * The one state of an item at an instant. Off beats sold out beats outside-the-window beats orderable. An item outside its window is
 * browsable and buildable but cannot be ordered; the answer says which window it belongs to and when it opens next.
 */
export function availabilityOf(product: { id: string; category: string; soldOut?: boolean }, w: MenuWindows | undefined, now: number, timeZone: string = DEFAULT_TIME_ZONE, off = false): Availability {
  if (off) return { state: "OFF" };
  if (product.soldOut) return { state: "SOLD_OUT" };
  const ev = evaluateWindows(windowsFor(w, product), now, timeZone);
  if (ev.open) return { state: "ORDERABLE", ...(ev.closesAt !== undefined ? { closesAt: ev.closesAt } : {}) };
  return { state: "AVAILABLE_LATER", ...(ev.next ? { window: ev.next } : {}), ...(ev.nextOpenAt !== undefined ? { nextOpeningAt: ev.nextOpenAt } : {}) };
}

/** The state of the menu as a whole (its own windows): orderable now, or when it opens next. */
export function menuState(w: MenuWindows | undefined, now: number, timeZone: string = DEFAULT_TIME_ZONE): Availability {
  const ev = evaluateWindows(w?.menu, now, timeZone);
  if (ev.open) return { state: "ORDERABLE", ...(ev.closesAt !== undefined ? { closesAt: ev.closesAt } : {}) };
  return { state: "AVAILABLE_LATER", ...(ev.next ? { window: ev.next } : {}), ...(ev.nextOpenAt !== undefined ? { nextOpeningAt: ev.nextOpenAt } : {}) };
}

/**
 * The most recent moment, at or before `now`, when any window opened or closed (epoch ms; 0 = none). It stands still between boundaries and
 * moves on at each one, so a menu version built from it changes exactly when an item's state can flip, with nothing to reload by hand.
 */
export function lastBoundaryAt(w: MenuWindows | undefined, now: number, timeZone: string = DEFAULT_TIME_ZONE): number {
  const all: WindowSlot[] = [...(w?.menu ?? []), ...Object.values(w?.categories ?? {}).flat(), ...Object.values(w?.products ?? {}).flat()];
  if (!all.length) return 0;
  let best = 0;
  for (const i of intervals(all, now - 8 * 86_400_000, timeZone)) {
    if (i.start <= now && i.start > best) best = i.start;
    if (i.end <= now && i.end > best) best = i.end;
  }
  return best;
}

/** Problems with a set of windows. Empty means fine. */
export function validateWindows(w: MenuWindows): string[] {
  const problems: string[] = [];
  const check = (label: string, slots: unknown) => {
    if (!Array.isArray(slots)) { problems.push(`${label}: windows must be a list`); return; }
    for (const s of slots as WindowSlot[]) {
      if (!s || !Number.isInteger(s.day) || s.day < 0 || s.day > 6) problems.push(`${label}: day must be 0 (Sunday) to 6 (Saturday)`);
      else if (typeof s.start !== "string" || typeof s.end !== "string" || !HHMM.test(s.start) || !HHMM.test(s.end) || s.start === "24:00") problems.push(`${label}: times must be HH:MM (start 00:00-23:59, end up to 24:00)`);
      else if (s.start === s.end) problems.push(`${label}: a window cannot start and end at the same time`);
    }
  };
  if (w.menu !== undefined) check("menu", w.menu);
  for (const [k, v] of Object.entries(w.categories ?? {})) check(`category ${k}`, v);
  for (const [k, v] of Object.entries(w.products ?? {})) check(`item ${k}`, v);
  return problems;
}

/** Whether a time zone name is one the runtime knows. */
export function isTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
