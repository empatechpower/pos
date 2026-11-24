import { useEffect } from "react";
import { clearSession, currentStaff, staffFetch, useStaff } from "./auth";
import { go } from "./nav";
import { shiftSettings } from "./shift";
import { isTraining } from "./training";

/**
 * Locking a till signs the person out of the screen but leaves their shift and the order on screen as they were, so anyone can sign in and take over.
 * The lock is written to the audit log. A till locks by itself after the shop's idle minutes (3 unless the shop says otherwise).
 */
const LS_NOTE = "pos.lockNote";
export async function lockNow(auto: boolean): Promise<void> {
  if (!currentStaff()) return;
  if (!isTraining()) await staffFetch("/api/auth/lock", { method: "POST", body: { auto } }).catch(() => undefined);
  clearSession();
  if (auto) localStorage.setItem(LS_NOTE, `Locked after ${shiftSettings().lockMinutes} minutes of no use. Sign in to carry on; the order on screen is kept.`);
  go("/login");
}
export const takeLockNote = (): string | null => { const n = localStorage.getItem(LS_NOTE); if (n) localStorage.removeItem(LS_NOTE); return n; };

/** Watches for use; locks the till when nothing has been touched for the shop's idle minutes. */
export function useIdleLock(): void {
  const staff = useStaff();
  useEffect(() => {
    if (!staff) return;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const evs = ["pointerdown", "keydown", "touchstart"] as const;
    evs.forEach((e) => window.addEventListener(e, touch, true));
    const t = window.setInterval(() => {
      const m = shiftSettings().lockMinutes;
      if (m > 0 && Date.now() - last > m * 60_000) void lockNow(true);
    }, 10_000);
    return () => { evs.forEach((e) => window.removeEventListener(e, touch, true)); window.clearInterval(t); };
  }, [staff?.code]);
}
