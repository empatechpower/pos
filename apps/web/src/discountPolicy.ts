import { staffFetch } from "./auth";
import { isTraining } from "./training";

/** What a cashier may do alone before a manager has to approve. Kept so the till still knows it offline. */
export interface DiscountPolicy { cashierMaxPercent: number; cashierMaxAmountCents: number; overrideNeedsManager: boolean }
const LS = "pos.discountPolicy";
const FALLBACK: DiscountPolicy = { cashierMaxPercent: 10, cashierMaxAmountCents: 500, overrideNeedsManager: true };

export const cachedPolicy = (): DiscountPolicy => {
  try { return { ...FALLBACK, ...(JSON.parse(localStorage.getItem(LS) ?? "null") ?? {}) }; } catch { return FALLBACK; }
};
export async function loadDiscountPolicy(): Promise<DiscountPolicy> {
  const r = await staffFetch("/api/settings/discounts");
  if ("res" in r && r.res.ok) { const p = (await r.res.json()) as DiscountPolicy; localStorage.setItem(LS, JSON.stringify(p)); return p; }
  return cachedPolicy();
}

export interface Approver { id: string; name: string }
const ERRORS: Record<string, string> = {
  manager_approval_needed: "Enter a manager's code and PIN.",
  approval_refused: "That manager code or PIN is not right.",
  approver_locked: "That manager is locked out for a few minutes after too many wrong PINs.",
  approver_cannot_approve: "That person is not a manager.",
};
/** Check a manager's code and PIN with the server (needs a connection). */
export async function askApproval(code: string, pin: string, purpose: string): Promise<{ ok: true; approver: Approver } | { ok: false; error: string }> {
  // Practice: any code and PIN stand in for a manager, so the steps can be rehearsed; nothing is checked or recorded.
  if (isTraining()) return code.trim() && pin ? { ok: true, approver: { id: "practice", name: "Manager (practice)" } } : { ok: false, error: "Enter a manager code and PIN to practise." };
  const r = await staffFetch("/api/approvals", { method: "POST", body: { approverCode: code.trim(), approverPin: pin, purpose } });
  if (!("res" in r)) return { ok: false, error: r.problem };
  const j = (await r.res.json().catch(() => ({}))) as { approver?: Approver; error?: string };
  return r.res.ok && j.approver ? { ok: true, approver: j.approver } : { ok: false, error: ERRORS[j.error ?? ""] ?? "Could not check that approval. Try again." };
}

/** Does a cashier need a manager for this? Managers and owners never do. */
export function needsApproval(role: string, p: DiscountPolicy, what: { kind: "percent" | "amount" | "price"; value: number }): boolean {
  if (role !== "cashier") return false;
  if (what.kind === "price") return p.overrideNeedsManager;
  return what.kind === "percent" ? what.value > p.cashierMaxPercent : what.value > p.cashierMaxAmountCents;
}
