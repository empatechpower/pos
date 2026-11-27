import { useSyncExternalStore } from "react";
import { adoptDeviceId } from "./db";

/**
 * This device's identity with the server. Enrolling trades a one-time code (made by a manager) for a
 * long-lived token. Everything the device sends carries it; the server can revoke it at any time.
 */
const LS_TOKEN = "pos.deviceToken";
const LS_REQUIRED = "pos.deviceRequired";
const LS_DEVICE_ID = "pos.deviceId";

interface DeviceState {
  /** Does this server insist on enrolled devices? (false in plain local development) */
  required: boolean;
  token: string | null;
  /** The server said this token is no longer good (revoked or unknown). */
  rejected: boolean;
}
let state: DeviceState = {
  required: localStorage.getItem(LS_REQUIRED) === "1",
  token: localStorage.getItem(LS_TOKEN),
  rejected: false,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<DeviceState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export const getDeviceState = () => state;

/** What this device is for (decision Q11: the kitchen display is the same app, switched by a setting on the device). Kept on the device. */
export type DeviceRole = "till" | "kitchen";
const LS_ROLE = "pos.deviceRole";
export const deviceRole = (): DeviceRole => (localStorage.getItem(LS_ROLE) === "kitchen" ? "kitchen" : "till");
export const setDeviceRole = (r: DeviceRole) => { try { localStorage.setItem(LS_ROLE, r); } catch { /* not kept */ } };
export const useDevice = (): DeviceState =>
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );

/** True when this device must enrol before it can do anything that talks to the server. */
export const needsEnrollment = (s: DeviceState = state) => s.required && (!s.token || s.rejected);

export const deviceHeader = (): Record<string, string> => (state.token ? { "x-device-token": state.token } : {});

/** The server answered 401 device_not_enrolled: keep local data, but stop and ask to re-enrol. */
export function markDeviceRejected() {
  // An owner disconnected and reset this device: the server's answer has just cleared everything stored here (the token went with it).
  // Start again from the latest version rather than show "this device was disconnected" over a page that no longer has its data.
  if (state.token && !localStorage.getItem(LS_TOKEN)) { location.reload(); return; }
  // A 401 also tells us the server enforces enrollment, even if we never managed to ask it.
  localStorage.setItem(LS_REQUIRED, "1");
  modeKnown = true;
  // "Removed" only makes sense for a device that held a token; a new one just needs to enrol.
  set({ rejected: !!state.token, required: true });
}

let modeKnown = false;

/** Ask the server whether enrollment is enforced. Retried until it answers once. */
export async function refreshDeviceMode(): Promise<void> {
  if (modeKnown) return;
  try {
    const res = await fetch("/api/auth/mode");
    if (!res.ok) return;
    const { deviceRequired } = (await res.json()) as { deviceRequired: boolean };
    modeKnown = true;
    localStorage.setItem(LS_REQUIRED, deviceRequired ? "1" : "0");
    set({ required: deviceRequired });
  } catch {
    /* offline: keep what we knew */
  }
}

/** Take on a device made for us by the server (a one-time Telegram link), the same way enrolling with a code does. */
export async function adoptLinkedDevice(token: string, deviceId: string): Promise<void> {
  const previous = localStorage.getItem(LS_DEVICE_ID);
  localStorage.setItem(LS_DEVICE_ID, deviceId);
  if (previous && previous !== deviceId) await adoptDeviceId(deviceId);
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_REQUIRED, "1");
  set({ token, rejected: false, required: true });
}

export type EnrollFailure = "invalid" | "limited" | "unavailable" | "full" | "not_allowed" | "locked";

/** An owner or manager approves this device by signing in on it (phone number or staff code, and PIN). */
export async function approveThisDevice(who: { phone?: string; code?: string }, pin: string, name: string): Promise<{ ok: true } | { ok: false; reason: EnrollFailure; limit?: number }> {
  try {
    const res = await fetch("/api/devices/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...who, pin, name }) });
    const j = (await res.json().catch(() => ({}))) as { token?: string; deviceId?: string; error?: string; limit?: number };
    if (res.status === 409) return { ok: false, reason: "full", limit: j.limit };
    if (res.status === 403) return { ok: false, reason: "not_allowed" };
    if (res.status === 429) return { ok: false, reason: j.error === "locked" ? "locked" : "limited" };
    if (res.status === 401) return { ok: false, reason: "invalid" };
    if (!res.ok || !j.token || !j.deviceId) return { ok: false, reason: "unavailable" };
    await adoptLinkedDevice(j.token, j.deviceId);
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

export async function enrollDevice(code: string, name: string): Promise<{ ok: true } | { ok: false; reason: EnrollFailure; limit?: number }> {
  try {
    const res = await fetch("/api/devices/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
    if (res.status === 409) return { ok: false, reason: "full", limit: ((await res.json().catch(() => ({}))) as { limit?: number }).limit };
    if (res.status === 429) return { ok: false, reason: "limited" };
    if (res.status === 401) return { ok: false, reason: "invalid" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    const j = (await res.json()) as { token: string; deviceId: string };
    // Orders taken before enrolling carry the old random id; the server only accepts a device's own id.
    const previous = localStorage.getItem(LS_DEVICE_ID);
    localStorage.setItem(LS_DEVICE_ID, j.deviceId);
    if (previous && previous !== j.deviceId) await adoptDeviceId(j.deviceId);
    localStorage.setItem(LS_TOKEN, j.token);
    set({ token: j.token, rejected: false });
    return { ok: true };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
