import { deviceRole } from "../device";
import { go } from "../nav";
import { useStaff } from "../auth";
import { useOrders } from "../hooks";
import { useShift } from "../shift";
import { lockNow } from "../lock";
import { isTraining } from "../training";
import { statusOf } from "./Orders";
import { useTillSettings } from "../till/tillSettings";
import type { BusinessConfig } from "@pos/core";
import "../proto/proto.css";
import "../proto/extra.css";

/**
 * The header of the till screens. The markup and class names are the prototype's own (proto-reference/index.html, viewHead and render), styled by
 * its stylesheet: logo, gear, the nav buttons, the outlet, who is signed in, the shift, Log out and Lock.
 * Ours adds two things the prototype has no need for, and only when they matter: a pill when the till is offline or has orders waiting to sync,
 * and a button for new online orders.
 * `bare` gives just the <header> for a screen that already sits inside the prototype's ".app"; otherwise it brings its own ".proto" wrapper.
 */
export function TillHeader({ route, config, connected, pending, newOnline, hasTables, onSync, syncError, bare }: { route: string; config: BusinessConfig | null; connected: boolean; pending: number; newOnline: number; hasTables: boolean; onSync: () => void; syncError?: string | null; bare?: boolean }) {
  const staff = useStaff();
  const orders = useOrders();
  const shift = useShift();
  const till = useTillSettings();
  const open = config ? orders.filter((o) => o.lines.length > 0 && statusOf(o, config) === "open").length : 0;
  const head = (
    <header>
      <h1><img className="brandlogo headlogo" src="/assets/rezein-logo.png" alt="Rezein" /></h1>
      {staff && (
        <>
          <button onClick={() => go("/settings")} aria-label="Settings">⚙</button>
          <span className="headnav">
            {route !== "pos" && <button onClick={() => go("/pos")}>Order</button>}
            <button onClick={() => go("/orders")}>Orders{open ? ` (${open})` : ""}</button>
            <button onClick={() => go("/pos?dialog=shift")}>Drawer</button>
            <button onClick={() => go("/pos?dialog=reports")}>Reports</button>
            {till.dashboard && <button onClick={() => go("/dashboard")}>Home</button>}
            {hasTables && <button onClick={() => go("/pos?view=tables")}>Table Map</button>}
            {deviceRole() === "kitchen" && <button onClick={() => go("/kitchen")}>Kitchen</button>}
            {newOnline > 0 && <button onClick={() => go("/online")}>Online ({newOnline})</button>}
          </span>
        </>
      )}
      <span className="outlet">{config?.name ?? ""}</span>
      <div className="spacer" />
      {staff && <span className="staffname">{staff.name}</span>}
      <span className="shiftchip">{staff && shift ? <>Drawer {shift.drawer}<span className="shiftopen"> · Shift open</span></> : null}</span>
      {(isTraining() || !connected || pending > 0) && <button className="syncpill" onClick={onSync} title={syncError ? `Last sync problem: ${syncError}. Tap to try again.` : "Tap to sync now"}>{isTraining() ? "Practice" : connected ? "Syncing" : "Offline"}{pending > 0 ? ` · ${pending}` : ""}</button>}
      {staff && <button onClick={() => go("/login")}>Log out</button>}
      {staff && <button onClick={() => void lockNow(false)}>Lock</button>}
    </header>
  );
  return bare ? head : <div className="proto protohead">{head}</div>;
}
