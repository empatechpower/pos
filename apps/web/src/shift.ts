import { useSyncExternalStore } from "react";
import { currentStaff, staffFetch } from "./auth";
import { isTraining } from "./training";

/** The signed-in cashier's open shift, as this till knows it. Kept on the device so payments taken offline still carry the shift. */
export interface Shift { id: string; drawer: 1 | 2; staffCode: string; staffName: string; openedAt: number; openingFloatCents: number }
export interface ShiftReport {
  shift: Shift & { closedAt: number | null; countedCents: number | null; expectedCents: number | null; varianceCents: number | null; closedByName: string | null; note: string | null; approvedByName?: string | null; dispositions?: Array<{ orderId: string; queueNumber: string | null; decision: string; by: string; at: number }> };
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
export const currentShiftId = (): string | undefined => (isTraining() ? undefined : mine()?.id);
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

export async function openShift(floatCents: number, denominations?: Record<string, number>): Promise<{ ok: true; shift: Shift } | { ok: false; error: string }> {
  const r = await staffFetch("/api/shifts/open", { method: "POST", body: { openingFloatCents: floatCents, ...(denominations && Object.keys(denominations).length ? { denominations } : {}) } });
  if (!("res" in r)) return { ok: false, error: r.problem };
  const j = (await r.res.json().catch(() => ({}))) as { shift?: Shift; error?: string };
  if (r.res.ok && j.shift) { set(j.shift); return { ok: true, shift: j.shift }; }
  if (j.error === "already_open" && j.shift) { set(j.shift); return { ok: true, shift: j.shift }; }
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

/** Count the drawer in the middle of a shift: the count is kept, and the till answers with what it expected. */
export async function drawerCount(id: string, countedCents: number, denominations: Record<string, number>): Promise<{ countedCents: number; expectedCents: number; varianceCents: number } | string> {
  const r = await staffFetch(`/api/shifts/${id}/count`, { method: "POST", body: { countedCents, denominations } });
  if (!("res" in r)) return r.problem;
  return r.res.ok ? ((await r.res.json()) as { countedCents: number; expectedCents: number; varianceCents: number }) : "That count was not kept. Check the amount and try again.";
}
export interface DrawerHistory { openingFloatCents: number; openedAt: number; rows: Array<{ at: number; what: string; amountCents: number | null; by: string }> }
export async function drawerHistory(id: string): Promise<DrawerHistory | null> {
  const r = await staffFetch(`/api/shifts/${id}/history`);
  return "res" in r && r.res.ok ? ((await r.res.json()) as DrawerHistory) : null;
}

export interface OpenOrder { orderId: string; queueNumber: string | null; totalCents: number; paidCents: number; source: string; channel: string | null; openedAt: number }
export async function openOrders(id: string): Promise<OpenOrder[]> {
  const r = await staffFetch(`/api/shifts/${id}/open-orders`);
  return "res" in r && r.res.ok ? ((await r.res.json()) as { orders: OpenOrder[] }).orders : [];
}

export interface CloseExtras { denominations?: Record<string, number>; dispositions?: OpenOrder[]; leaveAllOpen?: boolean; approverCode?: string; approverPin?: string }
export type CloseResult = { ok: true; report: ShiftReport } | { ok: false; error: string; needs?: "approval" | "orders"; orders?: OpenOrder[]; varianceCents?: number };
/** Close a shift with what was counted. The shop's rules may ask for a manager's PIN (a difference) or an answer for each open order first. */
export async function closeShift(id: string, countedCents: number, note: string, clearMine: boolean, extra: CloseExtras = {}): Promise<CloseResult> {
  const body = { countedCents, note, ...(extra.denominations && Object.keys(extra.denominations).length ? { denominations: extra.denominations } : {}), dispositions: (extra.dispositions ?? []).map((o) => ({ orderId: o.orderId, decision: "left_open" })), ...(extra.leaveAllOpen ? { leaveAllOpen: true } : {}), ...(extra.approverCode ? { approverCode: extra.approverCode, approverPin: extra.approverPin } : {}) };
  const r = await staffFetch(`/api/shifts/${id}/close`, { method: "POST", body });
  if (!("res" in r)) return { ok: false, error: r.problem };
  const j = (await r.res.json().catch(() => ({}))) as { report?: ShiftReport; error?: string; orders?: OpenOrder[]; varianceCents?: number };
  if (r.res.ok && j.report) { if (clearMine) set(null); return { ok: true, report: j.report }; }
  if (j.error === "already_closed") { if (clearMine) set(null); return { ok: false, error: "That shift was already closed." }; }
  if (j.error === "open_orders_unanswered") return { ok: false, error: "Some orders are still open.", needs: "orders", orders: j.orders ?? [] };
  if (j.error === "manager_approval_needed") return { ok: false, error: "The drawer is not balanced. A manager has to approve closing it.", needs: "approval", varianceCents: j.varianceCents };
  const text: Record<string, string> = {
    approval_refused: "That manager code or PIN is not right.",
    approver_locked: "That manager is locked out for a few minutes after too many wrong PINs.",
    approver_cannot_approve: "That person is not a manager.",
    variance_blocked: "The drawer does not balance, and this shop does not let a cashier close it that way. Recount, or ask a manager to close it.",
    counted_cash_required: "Enter the cash you counted.",
  };
  return { ok: false, error: text[j.error ?? ""] ?? "Could not close the shift. Try again." };
}

/** The shop's shift rules. Kept on the device so a till that starts offline still knows them. */
export interface ShiftSettings { required: boolean; variancePolicy: "proceed" | "managerpin" | "blocked"; dayEnd: boolean; lockMinutes: number }
const LS_SET = "pos.shiftSettings";
const DEFAULT: ShiftSettings = { required: false, variancePolicy: "managerpin", dayEnd: false, lockMinutes: 3 };
let settings: ShiftSettings = (() => { try { return { ...DEFAULT, ...(JSON.parse(localStorage.getItem(LS_SET) ?? "null") ?? {}) }; } catch { return DEFAULT; } })();
export async function loadShiftRequired(): Promise<void> {
  if (isTraining()) return;
  const r = await staffFetch("/api/settings/shifts");
  if ("res" in r && r.res.ok) { settings = { ...DEFAULT, ...((await r.res.json()) as ShiftSettings) }; localStorage.setItem(LS_SET, JSON.stringify(settings)); emit(); }
}
export const useShiftSettings = (): ShiftSettings => { useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, () => settings); return settings; };
export const useShiftRequired = (): boolean => useShiftSettings().required;
export const shiftSettings = (): ShiftSettings => settings;
