import { useSyncExternalStore } from "react";
import { deviceHeader, markDeviceRejected } from "./device";

/** Staff sign-in. The token lives on this device; the server decides what it may do. */
export interface StaffInfo {
  name: string;
  code: string;
  role: "cashier" | "manager" | "owner";
}

const LS_TOKEN = "pos.token";
const LS_STAFF = "pos.staff";
let staff: StaffInfo | null = JSON.parse(localStorage.getItem(LS_STAFF) ?? "null");
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

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

export async function signIn(code: string, pin: string): Promise<{ ok: true } | { ok: false; reason: "invalid" | "locked" | "unavailable" }> {
  try {
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", ...deviceHeader() }, body: JSON.stringify({ code, pin }) });
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
