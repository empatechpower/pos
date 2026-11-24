import { useSyncExternalStore } from "react";

/**
 * App updates are never automatic on a till (TengSern, Q17). A new version downloads in the background and waits; the staff screens show a quiet
 * notice and the update applies only when the cashier taps Update now. The kiosk holds it for a quiet start screen. The app asks for a new
 * version when it opens, every 15 minutes, and when it comes back to the foreground.
 */
let pending = false;
let dismissed = false;
let apply: (reload?: boolean) => Promise<void> = async () => undefined;
let registration: ServiceWorkerRegistration | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const setUpdater = (fn: (reload?: boolean) => Promise<void>) => { apply = fn; };
export const setRegistration = (r: ServiceWorkerRegistration) => { registration = r; };
export const markUpdateReady = () => { pending = true; dismissed = false; emit(); };
/** "Later": the notice goes away until the next check finds it still waiting. */
export const dismissUpdate = () => { dismissed = true; emit(); };
/** Activates the waiting version; the page reloads itself once. */
export const applyUpdate = () => void apply(true);
export const useUpdatePending = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => pending);
export const useUpdateNotice = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => pending && !dismissed);

/** Ask the server whether a newer version exists. Resolves true when one is now waiting. */
export async function checkForUpdate(): Promise<boolean> {
  try { await registration?.update(); } catch { return pending; }
  if (pending) { dismissed = false; emit(); }
  return pending;
}
export const appVersion = (): string => (typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev");
