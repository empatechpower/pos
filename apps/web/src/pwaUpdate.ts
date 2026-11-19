import { useSyncExternalStore } from "react";

/**
 * App updates. A new version downloads in the background and waits. Everywhere except the kiosk it is taken at once. The kiosk holds
 * it until it is back on a quiet start screen, so a customer's order is never interrupted by a reload (handover, section 9, item 7).
 */
let pending = false;
let apply: (reload?: boolean) => Promise<void> = async () => undefined;
const listeners = new Set<() => void>();

export const setUpdater = (fn: (reload?: boolean) => Promise<void>) => { apply = fn; };
export const markUpdateReady = () => { pending = true; listeners.forEach((l) => l()); };
/** Activates the waiting version; the page reloads itself once. */
export const applyUpdate = () => void apply(true);
export const useUpdatePending = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => pending);
