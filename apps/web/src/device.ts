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

export async function enrollDevice(code: string, name: string): Promise<{ ok: true } | { ok: false; reason: "invalid" | "limited" | "unavailable" }> {
  try {
    const res = await fetch("/api/devices/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
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
