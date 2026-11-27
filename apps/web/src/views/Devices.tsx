import { DisplayLink } from "./DisplayLink";
import { askConfirm } from "../proto/confirm";
import { PaynowPanel } from "./PaynowPanel";
import { UnassignedPanel } from "./UnassignedPanel";
import { ShiftsPanel } from "./ShiftsPanel";
import { FloorPanel } from "./FloorPanel";
import { DiscountPolicyPanel } from "./DiscountPolicyPanel";
import { TrainingPanel } from "./TrainingPanel";
import { useEffect, useState } from "react";
import { hasPerm, authHeader, useStaff } from "../auth";

interface Row {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
  last_seen_at: string | null;
  outlet_id?: string;
  wipe_requested?: boolean;
}
interface OutletRow { id: string; name: string }

const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};

/** Managers and owners: add a device (one-time code), see what's enrolled, remove a lost one. */
export function Devices() {
  const staff = useStaff();
  const [rows, setRows] = useState<Row[]>([]);
  const [licence, setLicence] = useState<{ limit: number | null; active: number } | null>(null);
  const [code, setCode] = useState<{ code: string; reissueFor?: string; testing?: boolean; outlet?: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [outlets, setOutlets] = useState<OutletRow[]>([]);
  const [outletId, setOutletId] = useState("");

  const load = async () => {
    const res = await fetch("/api/devices", { headers: authHeader() }).catch(() => null);
    if (res?.ok) { const j = (await res.json()) as { devices: Row[]; limit?: number | null; active?: number }; setRows(j.devices); setLicence({ limit: j.limit ?? null, active: j.active ?? j.devices.filter((d) => d.active).length }); }
  };
  useEffect(() => {
    if (!staff) return;
    void load();
    void (async () => {
      const res = await fetch("/api/outlets", { headers: authHeader() }).catch(() => null);
      if (res?.ok) {
        const list = ((await res.json()) as { outlets: OutletRow[] }).outlets;
        setOutlets(list);
        setOutletId((cur) => cur || list[0]?.id || "");
      }
    })();
    const t = window.setInterval(() => void load(), 8000); // a device enrolling elsewhere shows up on its own
    return () => window.clearInterval(t);
  }, [staff]);

  if (!staff) return <div className="credit"><h2>Devices</h2><p className="muted">Sign in as a manager or owner to manage devices. <a href="/login">Sign in</a></p></div>;
  if (!hasPerm(staff, "device.manage")) return <div className="credit"><h2>Devices</h2><p className="muted">Only managers and owners can manage devices.</p></div>;

  const outletName = (id?: string) => outlets.find((o) => o.id === id)?.name ?? id ?? "";
  async function makeCode(deviceId?: string, testing = false, forOutlet?: string) {
    setMsg(null);
    // A new device joins the outlet chosen above; a device being re-enrolled stays at its own outlet.
    const chosen = forOutlet ?? (outlets.length > 1 ? outletId : undefined);
    const res = await fetch("/api/devices/enrollment", { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ deviceId, testing, ...(chosen ? { outletId: chosen } : {}) }) }).catch(() => null);
    if (res?.ok) setCode({ code: ((await res.json()) as { code: string }).code, reissueFor: deviceId, testing, outlet: chosen });
    else setMsg("Could not create a code. Check the connection and your sign-in.");
  }

  async function revoke(r: Row, reset = false) {
    const ask = reset
      ? { title: "Disconnect and reset?", message: `"${r.name}" stops working straight away. The next time it reaches the server, its browser clears this app's copy and everything the app kept there, then opens fresh on the latest version, ready to be set up again. Orders on it that were not sent yet are lost. Use this for a device stuck on an old version, or one that is lost.`, ok: "Disconnect and reset", cancel: "Keep" }
      : { title: "Disconnect this device?", message: `"${r.name}" stops working straight away. What is on it stays on it, and is sent once it is set up again.`, ok: "Disconnect", cancel: "Keep" };
    if (!(await askConfirm(ask))) return;
    const res = await fetch(`/api/devices/${r.id}/revoke`, { method: "POST", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ reset }) }).catch(() => null);
    setMsg(res?.ok ? (reset ? `${r.name} disconnected. It resets the next time it is opened with a connection.` : `${r.name} disconnected.`) : "Could not disconnect that device (you can't disconnect the one you're using).");
    void load();
  }

  return (
    <div className="credit">
      <h2>Devices</h2>
      <DisplayLink />
      {outlets.length > 1 && (
        <label className="cust" style={{ marginBottom: 8 }}>
          <span>Which outlet is the device for?</span>
          <select value={outletId} onChange={(e) => setOutletId(e.target.value)}>
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}
      {licence && <p className="muted" role="status">{licence.limit !== null ? `${licence.active} of ${licence.limit} devices connected (your licence).` : `${licence.active} devices connected.`} A new device can also be approved by an owner or manager signing in on it.</p>}
      <button className="primary" onClick={() => void makeCode()}>Add a device</button>{" "}
      <button className="secondary" onClick={() => void makeCode(undefined, true)}>Code for testing many devices</button>
      {code && (
        <div className="flash codebox">
          <div>{code.reissueFor ? "Re-enrollment code" : "Enrollment code"}{code.outlet ? ` · ${outletName(code.outlet)}` : ""}</div>
          <b className="bigcode">{code.code}</b>
          <div className="muted">{code.testing ? "Type it on each device you want to add. Works for up to 25 devices and expires in 4 hours. Use it for testing only." : "Type it on the new device. Works once, expires in 15 minutes."}</div>
        </div>
      )}
      {msg && <div className="flash">{msg}</div>}
      {rows.map((r) => (
        <div className="tab" key={r.id}>
          <div>
            <b>{r.name}</b> {!r.active && <span className="muted">· {r.wipe_requested ? "disconnected, resets when next opened" : "disconnected"}</span>}
            <div className="muted">{outlets.length > 1 && r.outlet_id ? `${outletName(r.outlet_id)} · ` : ""}last seen {ago(r.last_seen_at)}</div>
          </div>
          <div className="tabr">
            {!r.active && <button className="secondary sm" onClick={() => void makeCode(r.id, false, r.outlet_id)}>Re-enrol</button>}
            {r.active && <button className="secondary sm" onClick={() => void revoke(r)}>Disconnect</button>}
            {!r.wipe_requested && <button className="secondary sm" onClick={() => void revoke(r, true)}>Disconnect and reset</button>}
          </div>
        </div>
      ))}
      <PaynowPanel />
      <ShiftsPanel />
      <FloorPanel />
      <DiscountPolicyPanel />
      <TrainingPanel />
      <UnassignedPanel />
    </div>
  );
}
