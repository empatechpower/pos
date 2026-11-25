import { useSyncExternalStore } from "react";
import { deviceHeader, markDeviceRejected } from "./device";
import { isTraining } from "./training";

/** Staff sign-in. The token lives on this device; the server decides what it may do. */
export interface StaffInfo {
  name: string;
  code: string;
  role: "cashier" | "manager" | "owner";
  /** Which franchise or outlet this login is limited to. Both empty = the whole brand. */
  franchiseId?: string | null;
  outletId?: string | null;
  /** The phone number with its middle hidden, for the staff buttons on the sign-in screen. */
  phoneHint?: string | null;
  /** What this person may do, as the shop set it for their role (from sign-in). Missing on a session from before this existed. */
  permissions?: string[];
}

const LS_TOKEN = "pos.token";
const LS_STAFF = "pos.staff";
let staff: StaffInfo | null = JSON.parse(localStorage.getItem(LS_STAFF) ?? "null");
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Who is signed in on this device right now (read without React). */
export const currentStaff = (): StaffInfo | null => staff;
/** May this person do it without a manager? A session without a list falls back to the old rule: managers and owners may, cashiers may not. */
export const hasPerm = (s: StaffInfo | null | undefined, p: string): boolean => !!s && (s.permissions ? s.permissions.includes(p) : s.role !== "cashier");
export const getToken = () => localStorage.getItem(LS_TOKEN);
/** Staff token plus this device's token: the server wants both for anything that touches money. */
export const authHeader = (): Record<string, string> => {
  const t = getToken();
  return { ...deviceHeader(), ...(t ? { authorization: `Bearer ${t}` } : {}) };
};
export const useStaff = (): StaffInfo | null =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => staff,
  );

/** Forget the session on this device (sign out, or the server said it is no longer valid). */
export function clearSession() {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_STAFF);
  staff = null;
  emit();
}

export async function signIn(who: string | { phone: string }, pin: string): Promise<{ ok: true } | { ok: false; reason: "invalid" | "locked" | "unavailable" }> {
  try {
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...deviceHeader() }, body: JSON.stringify(typeof who === "string" ? { code: who, pin } : { phone: who.phone, pin }) });
    if (res.status === 401 && (await res.clone().json().catch(() => ({}))).error === "device_not_enrolled") {
      markDeviceRejected();
      return { ok: false, reason: "unavailable" };
    }
    if (res.status === 429) return { ok: false, reason: "locked" };
    if (res.status === 401) return { ok: false, reason: "invalid" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    const j = (await res.json()) as { token: string; staff: StaffInfo };
    localStorage.setItem(LS_TOKEN, j.token);
    localStorage.setItem(LS_STAFF, JSON.stringify(j.staff));
    staff = j.staff;
    emit();
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/** Start a session the server has already granted (a one-time Telegram link), with no PIN typed. */
export function adoptSession(token: string, info: StaffInfo) {
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_STAFF, JSON.stringify(info));
  staff = info;
  emit();
}

export async function signOut() {
  const headers = authHeader();
  clearSession();
  await fetch("/api/auth/logout", { method: "POST", headers }).catch(() => {});
}

/**
 * A request that needs a signed-in staff member on an enrolled device. Returns the response, or a
 * plain-words reason when it could not be made or the session/device is no longer good.
 */
export async function staffFetch(path: string, init: { method?: string; body?: object } = {}): Promise<{ res: Response } | { problem: string }> {
  // In practice mode nothing is sent to the shop's systems: reading is fine, changing anything is not.
  if (isTraining() && (init.method ?? (init.body ? "POST" : "GET")) !== "GET") return { problem: "Training mode: this is not sent to the shop's systems. Leave training mode to do it for real." };
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...authHeader() },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return { problem: "Could not reach the server. Nothing was changed." };
  }
  if (res.status === 401) {
    const code = ((await res.clone().json().catch(() => ({}))) as { error?: string }).error;
    if (code === "device_not_enrolled") markDeviceRejected();
    else clearSession();
    return { problem: "Your session has ended. Sign in again." };
  }
  if (res.status === 403) return { problem: "This account isn't allowed to do that." };
  return { res };
}
