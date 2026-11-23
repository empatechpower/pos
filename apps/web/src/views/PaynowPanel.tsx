import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { staffFetch } from "../auth";

type Proxy = "uen" | "mobile" | "nric" | "vpa";
const hint: Record<Proxy, string> = { uen: "e.g. 201912345K", mobile: "e.g. +6591234567", nric: "e.g. S1234567D", vpa: "the PayNow address" };
const blank = { proxyType: "uen" as Proxy, proxyValue: "", displayName: "", outletCode: "", ttlMinutes: "3", alertSender: "", receivingAccountEnding: "", minAmount: "", maxAmount: "" };

/**
 * The shop's own PayNow: who the QR pays, the name the customer sees in their banking app, and (optionally) the bank's alert
 * sender so payments confirm by themselves. A S$0.01 test QR lets the owner check it with their own banking app before customers see it.
 */
export function PaynowPanel() {
  const [f, setF] = useState(blank);
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState("");
  const [test, setTest] = useState<{ img: string; name: string; until: number } | null>(null);

  const load = useCallback(async () => {
    const r = await staffFetch("/api/settings/paynow");
    if (!("res" in r) || !r.res.ok) return;
    const c = ((await r.res.json()) as { config: null | { proxyType: Proxy; proxyValue: string; displayName: string; outletCode: string; ttlMinutes: number; alertSender?: string; receivingAccountEnding?: string; minCents?: number; maxCents?: number } }).config;
    if (c) { setF({ proxyType: c.proxyType, proxyValue: c.proxyValue, displayName: c.displayName, outletCode: c.outletCode, ttlMinutes: String(c.ttlMinutes), alertSender: c.alertSender ?? "", receivingAccountEnding: c.receivingAccountEnding ?? "", minAmount: c.minCents ? (c.minCents / 100).toFixed(2) : "", maxAmount: c.maxCents ? (c.maxCents / 100).toFixed(2) : "" }); setSaved(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setMsg(""); setTest(null);
    const r = await staffFetch("/api/settings/paynow", { method: "PUT", body: { proxyType: f.proxyType, proxyValue: f.proxyValue, displayName: f.displayName, outletCode: f.outletCode, ttlMinutes: Number(f.ttlMinutes), alertSender: f.alertSender, receivingAccountEnding: f.receivingAccountEnding, minCents: f.minAmount ? Math.round(Number(f.minAmount) * 100) : undefined, maxCents: f.maxAmount ? Math.round(Number(f.maxAmount) * 100) : undefined } });
    if (!("res" in r)) return setMsg(r.problem);
    if (r.res.ok) { setSaved(true); setMsg("Saved. Press “Show test QR” and scan it with your banking app to check."); void load(); }
    else setMsg(((await r.res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save.");
  }
  async function showTest() {
    setMsg("");
    const r = await staffFetch("/api/settings/paynow/test", { method: "POST", body: {} });
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("Save the PayNow details first.");
    const j = (await r.res.json()) as { payload: string; expiresAt: number; displayName: string };
    setTest({ img: await QRCode.toDataURL(j.payload, { margin: 4, width: 360 }), name: j.displayName, until: j.expiresAt });
  }
  const ok = f.proxyValue.trim() && f.displayName.trim() && /^[A-Za-z0-9]{2}$/.test(f.outletCode);

  return (
    <div style={{ marginTop: 24 }}>
      <h3>PayNow</h3>
      <p className="muted">Customers scan a QR that pays this PayNow directly, for the exact amount. Your banking app shows them the name below before they pay.</p>
      {msg && <div className="flash">{msg}</div>}
      <div className="row">
        <label className="field">PayNow to<select value={f.proxyType} onChange={(e) => setF({ ...f, proxyType: e.target.value as Proxy })}><option value="uen">Business (UEN)</option><option value="mobile">Mobile number</option><option value="nric">NRIC / FIN</option><option value="vpa">PayNow address (VPA)</option></select></label>
        <label className="field">PayNow ID<input value={f.proxyValue} onChange={(e) => setF({ ...f, proxyValue: e.target.value })} placeholder={hint[f.proxyType]} /></label>
      </div>
      <div className="row">
        <label className="field">Name customers see (25 letters at most)<input value={f.displayName} maxLength={25} onChange={(e) => setF({ ...f, displayName: e.target.value.toUpperCase() })} placeholder="e.g. BAILEY & PATCH" /></label>
        <label className="field">Shop code (2 letters or digits)<input value={f.outletCode} maxLength={2} onChange={(e) => setF({ ...f, outletCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} placeholder="e.g. B1" /></label>
        <label className="field">QR stays valid (minutes)<select value={f.ttlMinutes} onChange={(e) => setF({ ...f, ttlMinutes: e.target.value })}><option>3</option><option>4</option><option>5</option></select></label>
      </div>
      <div className="row">
        <label className="field">Smallest PayNow amount (S$, optional)<input inputMode="decimal" value={f.minAmount} onChange={(e) => setF({ ...f, minAmount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="no limit" /></label>
        <label className="field">Largest PayNow amount (S$, optional)<input inputMode="decimal" value={f.maxAmount} onChange={(e) => setF({ ...f, maxAmount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="no limit" /></label>
      </div>
      <details>
        <summary className="muted">Confirm payments automatically (optional)</summary>
        <p className="muted">Needs the bank’s “you’ve received a transfer” emails to reach the shop’s mailbox, and the bank alert set to its lowest amount (S$0.01).</p>
        <div className="row">
          <label className="field">Bank alert sender<input value={f.alertSender} onChange={(e) => setF({ ...f, alertSender: e.target.value })} placeholder="e.g. ibanking.alert@dbs.com" /></label>
          <label className="field">Account ends in<input inputMode="numeric" value={f.receivingAccountEnding} maxLength={6} onChange={(e) => setF({ ...f, receivingAccountEnding: e.target.value.replace(/\D/g, "") })} placeholder="last 3 to 6 digits" /></label>
        </div>
      </details>
      <div className="row"><button className="primary sm" disabled={!ok} onClick={() => void save()}>Save</button>{saved && <button className="secondary sm" onClick={() => void showTest()}>Show test QR (S$0.01)</button>}</div>
      {test && (
        <div style={{ marginTop: 12 }}>
          <img src={test.img} alt="Test PayNow QR" width={220} height={220} />
          <p className="muted">Scan with your banking app. It should show <b>{test.name}</b> and S$0.01. Pay it only if you want to try the automatic confirmation; the cent lands under unassigned payments. Valid until {new Date(test.until).toLocaleTimeString()}.</p>
        </div>
      )}
    </div>
  );
}
