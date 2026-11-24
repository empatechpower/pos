import { go } from "../nav";
import { useStaff } from "../auth";
import { useOrders } from "../hooks";
import { useShift } from "../shift";
import { lockNow } from "../lock";
import { isTraining } from "../training";
import { statusOf } from "./Orders";
import { useTillSettings } from "../till/tillSettings";
import type { BusinessConfig } from "@pos/core";

/**
 * The header of the till screens, as in the prototype: the Rezein logo, a gear, round-ended buttons for Orders, Drawer, Reports, Home and Table Map,
 * and on the right the outlet, who is signed in, the shift, Log out and Lock. A small pill says whether the till is connected.
 */
export function TillHeader({ route, config, connected, pending, newOnline, hasTables, onSync, syncError }: { route: string; config: BusinessConfig | null; connected: boolean; pending: number; newOnline: number; hasTables: boolean; onSync: () => void; syncError?: string | null }) {
  const staff = useStaff();
  const orders = useOrders();
  const shift = useShift();
  const till = useTillSettings();
  const open = config ? orders.filter((o) => o.lines.length > 0 && statusOf(o, config) === "open").length : 0;
  const on = (r: string) => (route === r ? "selected" : "");
  return (
    <header className={`thead ${route === "login" && !staff ? "thead-bare" : ""}`}>
      <a className="thead-logo" href={staff ? "/dashboard" : "/login"} aria-label="Rezein"><img src="/assets/rezein-logo.png" alt="Rezein" /></a>
      {staff && (
        <>
          <button className={on("settings")} onClick={() => go("/settings")} aria-label="Settings">⚙</button>
          <span className="thead-nav">
            <button className={on("orders")} onClick={() => go("/orders")}>Orders{open ? ` (${open})` : ""}</button>
            <button onClick={() => go("/pos?dialog=shift")}>Drawer</button>
            {staff.role !== "cashier" && <button onClick={() => go("/manager?tab=reports")}>Reports</button>}
            {till.dashboard && <button className={on("dashboard")} onClick={() => go("/dashboard")}>Home</button>}
            {hasTables && <button onClick={() => go("/pos?view=tables")}>Table Map</button>}
            {newOnline > 0 && <button onClick={() => go("/online")}>Online ({newOnline})</button>}
          </span>
        </>
      )}
      <span className="thead-outlet">{config?.name ?? ""}</span>
      <span className="thead-spacer" />
      {staff && <span className="thead-staff">{staff.name}</span>}
      {staff && shift && <span className="thead-shift">Drawer {shift.drawer}<span className="thead-open"> · Shift open</span></span>}
      {!(route === "login" && !staff) && <button className={`thead-pill ${connected ? "ok" : "off"}`} onClick={onSync} title={syncError ? `Last sync problem: ${syncError}. Tap to try again.` : "Tap to sync now"}><i /> {isTraining() ? "Practice" : connected ? "Online" : "Offline"}{pending > 0 ? ` · ${pending}` : ""}</button>}
      {staff && <button onClick={() => go("/login")}>Log out</button>}
      {staff && <button onClick={() => void lockNow(false)}>Lock</button>}
    </header>
  );
}
