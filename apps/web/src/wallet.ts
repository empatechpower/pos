/**
 * Prepaid credit. The server is the only authority on balances, so these calls need the network.
 * Every call carries an idempotency key: retrying after a dropped connection can never charge twice.
 */
import { authHeader, clearSession } from "./auth";
import { markDeviceRejected } from "./device";

export type WalletResult =
  | { ok: true; balanceCents: number; replayed: boolean }
  | { ok: false; reason: "insufficient_funds"; balanceCents: number }
  | { ok: false; reason: "signin_required" | "not_allowed" | "unavailable" | "credit_frozen" }
  | { ok: false; reason: "over_limit"; limitCents: number };

async function call(path: string, body: object): Promise<WalletResult> {
  try {
    const res = await fetch(`/api/wallet/${path}`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify(body) });
    if (res.status === 401) {
      if (((await res.json().catch(() => ({}))) as { error?: string }).error === "device_not_enrolled") markDeviceRejected();
      else clearSession();
      return { ok: false, reason: "signin_required" };
    }
    if (res.status === 403) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; limitCents?: number };
      if (j.error === "credit_frozen") return { ok: false, reason: "credit_frozen" };
      return j.error === "over_limit" ? { ok: false, reason: "over_limit", limitCents: j.limitCents ?? 0 } : { ok: false, reason: "not_allowed" };
    }
    if (res.status === 409) {
      const j = (await res.json()) as { balanceCents: number };
      return { ok: false, reason: "insufficient_funds", balanceCents: j.balanceCents };
    }
    if (!res.ok) return { ok: false, reason: "unavailable" };
    const j = (await res.json()) as { entry: { balanceAfter: number }; replayed: boolean };
    return { ok: true, balanceCents: j.entry.balanceAfter, replayed: j.replayed };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function getBalance(customerId: string): Promise<number | null> {
  try {
    const res = await fetch(`/api/wallet/${encodeURIComponent(customerId)}`, { headers: authHeader() });
    if (res.status === 401) {
      if (((await res.json().catch(() => ({}))) as { error?: string }).error === "device_not_enrolled") markDeviceRejected();
      else clearSession();
      return null;
    }
    return res.ok ? ((await res.json()) as { balanceCents: number }).balanceCents : null;
  } catch {
    return null;
  }
}

export const topUp = (customerId: string, amountCents: number, idempotencyKey: string, deviceId?: string) =>
  call("topup", { customerId, amountCents, idempotencyKey, deviceId });

export const spend = (customerId: string, amountCents: number, idempotencyKey: string, orderId: string, deviceId?: string) =>
  call("spend", { customerId, amountCents, idempotencyKey, orderId, deviceId });
