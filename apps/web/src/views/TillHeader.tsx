import { deviceRole } from "../device";
import { go } from "../nav";
import { useState } from "react";
import { signOut, useStaff } from "../auth";
import { ProtoModal } from "../proto/ProtoDialog";
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
export function TillHeader({ route, config, connected, pending, newOnline, hasTables, onSync, syncError, bare, showOrder }: { /** On the till itself: it is showing the Table Map or the checks, so "Order" leads back to the ticket. */ showOrder?: boolean; route: string; config: BusinessConfig | null; connected: boolean; pending: number; newOnline: number; hasTables: boolean; onSync: () => void; syncError?: string | null; bare?: boolean }) {
  const staff = useStaff();
  const [logoutAsk, setLogoutAsk] = useState(false);
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
            {(route !== "pos" || showOrder) && <button onClick={() => go(route === "pos" ? "/pos?view=order" : "/pos")}>Order</button>}
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
      {staff && <button onClick={() => setLogoutAsk(true)}>Log out</button>}
      {staff && <button onClick={() => void lockNow(false)}>Lock</button>}
    </header>
  );
  // Log out, by the owner's rule (decision Q28, prototype logoutAsk): it is available once the person has no open shift of their own.
  // With their shift still open, the dialog says so and leads to Drawer & Shift.
  const logout = logoutAsk && staff ? (
    shift ? (
      <ProtoModal title="You have an open shift" onClose={() => setLogoutAsk(false)}>
        <p>Your shift on <b>Drawer {shift.drawer}</b> is still open. Log out becomes available once you have no open shift of your own — close your shift first.</p>
        <div className="settingsgroup">
          <button className="primary" onClick={() => { setLogoutAsk(false); go("/pos?dialog=shift"); }}>Go to Drawer &amp; Shift</button>
          <button onClick={() => setLogoutAsk(false)}>Cancel</button>
        </div>
      </ProtoModal>
    ) : (
      <ProtoModal title="Log out" onClose={() => setLogoutAsk(false)}>
        <p>Log out of Rezein as <b>{staff.name}</b>?</p>
        <div className="settingsgroup">
          <button className="primary" onClick={() => { setLogoutAsk(false); void signOut().then(() => go("/login")); }}>Log out</button>
          <button onClick={() => setLogoutAsk(false)}>Cancel</button>
        </div>
      </ProtoModal>
    )
  ) : null;
  return bare ? <>{head}{logout}</> : <><div className="proto protohead">{head}</div>{logout}</>;
}
