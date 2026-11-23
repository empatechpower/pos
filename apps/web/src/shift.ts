import { useSyncExternalStore } from "react";
import { currentStaff, staffFetch } from "./auth";

/** The signed-in cashier's open shift, as this till knows it. Kept on the device so payments taken offline still carry the shift. */
export interface Shift { id: string; drawer: 1 | 2; staffCode: string; staffName: string; openedAt: number; openingFloatCents: number }
export interface ShiftReport {
  shift: Shift & { closedAt: number | null; countedCents: number | null; expectedCents: number | null; varianceCents: number | null; closedByName: string | null; note: string | null };
  tenders: Array<{ method: string; salesCents: number; refundsCents: number; netCents: number }>;
  orders: number;
  cashIn: Array<{ reason: string; amountCents: number; by: string; at: number }>;
  cashOut: Array<{ reason: string; amountCents: number; by: string; at: number }>;
  expectedCashCents: number;
}

const LS = "pos.shift";
let shift: Shift | null = JSON.parse(localStorage.getItem(LS) ?? "null");
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (s: Shift | null) => {
  shift = s;
  if (s) localStorage.setItem(LS, JSON.stringify(s)); else localStorage.removeItem(LS);
  emit();
};

/** The shift of whoever is signed in, or null. A shift left by someone else is not theirs to sell under. */
export const mine = (): Shift | null => (shift && currentStaff()?.code === shift.staffCode ? shift : null);
export const currentShiftId = (): string | undefined => mine()?.id;
export const useShift = (): Shift | null => {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => shift);
  return mine();
};

/** Ask the server which shift the signed-in person has open (it knows best), and keep the answer. */
export async function syncShift(): Promise<void> {
  if (!currentStaff()) return;
  const r = await staffFetch("/api/shifts/mine");
  if ("res" in r && r.res.ok) set(((await r.res.json()) as { shift: Shift | null }).shift);
}

export async function openShift(floatCents: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await staffFetch("/api/shifts/open", { method: "POST", body: { openingFloatCents: floatCents } });
  if (!("res" in r)) return { ok: false, error: r.problem };
  const j = (await r.res.json().catch(() => ({}))) as { shift?: Shift; error?: string };
  if (r.res.ok && j.shift) { set(j.shift); return { ok: true }; }
  if (j.error === "already_open" && j.shift) { set(j.shift); return { ok: true }; }
  return { ok: false, error: j.error === "both_drawers_in_use" ? "Both drawers on this till are in use. Ask a manager to close one." : j.error === "needs_an_enrolled_till" ? "This device is not enrolled as a till." : "Could not open the shift. Try again." };
}

export async function cashMove(kind: "in" | "out", amountCents: number, reason: string): Promise<string | null> {
  const s = mine();
  if (!s) return "No open shift.";
  const r = await staffFetch(`/api/shifts/${s.id}/cash`, { method: "POST", body: { kind, amountCents, reason } });
  if (!("res" in r)) return r.problem;
  if (r.res.ok) return null;
  const e = ((await r.res.json().catch(() => ({}))) as { error?: string }).error;
  return e === "reason_required" ? "Say what the money was for." : e === "shift_closed" ? "That shift is closed." : "Could not record that.";
}

export async function shiftReport(id: string): Promise<ShiftReport | null> {
  const r = await staffFetch(`/api/shifts/${id}/report`);
  return "res" in r && r.res.ok ? ((await r.res.json()) as ShiftReport) : null;
}

/** Close a shift with what was counted in the drawer. Returns the closing (Z) report, or why not. */
export async function closeShift(id: string, countedCents: number, note: string, clearMine: boolean): Promise<{ ok: true; report: ShiftReport } | { ok: false; error: string }> {
  const r = await staffFetch(`/api/shifts/${id}/close`, { method: "POST", body: { countedCents, note } });
  if (!("res" in r)) return { ok: false, error: r.problem };
  const j = (await r.res.json().catch(() => ({}))) as { report?: ShiftReport; error?: string };
  if (r.res.ok && j.report) { if (clearMine) set(null); return { ok: true, report: j.report }; }
  if (j.error === "already_closed") { if (clearMine) set(null); return { ok: false, error: "That shift was already closed." }; }
  return { ok: false, error: j.error === "counted_cash_required" ? "Enter the cash you counted." : "Could not close the shift. Try again." };
}

/** Whether this shop wants a shift opened before payments are taken (the owner's setting; off unless switched on). */
let required = false;
let requiredLoaded = false;
export async function loadShiftRequired(): Promise<void> {
  const r = await staffFetch("/api/settings/shifts");
  if ("res" in r && r.res.ok) { required = !!((await r.res.json()) as { required: boolean }).required; requiredLoaded = true; localStorage.setItem("pos.shiftRequired", required ? "1" : "0"); emit(); }
}
if (!requiredLoaded) required = localStorage.getItem("pos.shiftRequired") === "1"; // still known when the till starts offline
export const useShiftRequired = (): boolean => useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => required);
