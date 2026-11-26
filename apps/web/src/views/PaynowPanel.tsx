import { useCallback, useEffect, useState } from "react";
import { askConfirm } from "../proto/confirm";
import QRCode from "qrcode";
import { staffFetch } from "../auth";
import { MailboxesPanel, useMailboxes } from "./MailboxesPanel";

type Proxy = "uen" | "mobile" | "nric" | "vpa";
const hint: Record<Proxy, string> = { uen: "e.g. 201912345K", mobile: "e.g. +6591234567", nric: "e.g. S1234567D", vpa: "the PayNow address" };
const blank = { proxyType: "uen" as Proxy, proxyValue: "", displayName: "", outletCode: "", ttlMinutes: "2", alertSender: "", receivingAccountEnding: "", mailboxId: "", minAmount: "", maxAmount: "" };
interface Cfg { proxyType: Proxy; proxyValue: string; displayName: string; outletCode: string; ttlMinutes: number; alertSender?: string; receivingAccountEnding?: string; mailboxId?: string; minCents?: number; maxCents?: number }
interface Outlet { id: string; name: string }

/**
 * PayNow: who the QR pays, the name the customer sees in their banking app, and (optionally) how payments confirm by themselves: the bank's alert
 * sender, the account the money lands in, and the mailbox the alerts arrive in. The shop has one setup; any outlet can have its own (its own
 * account, shop code and mailbox), and the rest use the shop's. A S$0.01 test QR lets the owner check it with their own banking app.
 */
export function PaynowPanel() {
  const [outlets, setOutlets] = useState<Outlet[]>([]);
  const [outlet, setOutlet] = useState("");
  const [f, setF] = useState(blank);
  const [own, setOwn] = useState(false); // this outlet has setup of its own
  const [editOutlet, setEditOutlet] = useState(false); // the person pressed "Give this outlet its own"
  const [saved, setSaved] = useState(false);
  const [msg, setMsg] = useState("");
  const [test, setTest] = useState<{ img: string; name: string; until: number } | null>(null);
  const mail = useMailboxes();

  useEffect(() => {
    void (async () => {
      const r = await staffFetch("/api/outlets");
      if ("res" in r && r.res.ok) setOutlets(((await r.res.json()) as { outlets?: Outlet[] }).outlets ?? []);
    })();
  }, []);

  const load = useCallback(async () => {
    const q = outlet ? `?outlet=${encodeURIComponent(outlet)}` : "";
    const r = await staffFetch(`/api/settings/paynow${q}`);
    if (!("res" in r) || !r.res.ok) return;
    const j = (await r.res.json()) as { config: Cfg | null; overrides?: Record<string, unknown> };
    setOwn(!!outlet && !!j.overrides?.[outlet]);
    const c = j.config;
    if (c) { setF({ proxyType: c.proxyType, proxyValue: c.proxyValue, displayName: c.displayName, outletCode: c.outletCode, ttlMinutes: String(c.ttlMinutes), alertSender: c.alertSender ?? "", receivingAccountEnding: c.receivingAccountEnding ?? "", mailboxId: c.mailboxId ?? "", minAmount: c.minCents ? (c.minCents / 100).toFixed(2) : "", maxAmount: c.maxCents ? (c.maxCents / 100).toFixed(2) : "" }); setSaved(true); }
    else { setF(blank); setSaved(false); }
  }, [outlet]);
  useEffect(() => { setMsg(""); setTest(null); void load(); }, [load]);

  const body = () => ({ proxyType: f.proxyType, proxyValue: f.proxyValue, displayName: f.displayName, outletCode: f.outletCode, ttlMinutes: Number(f.ttlMinutes), alertSender: f.alertSender, receivingAccountEnding: f.receivingAccountEnding, mailboxId: f.mailboxId || undefined, minCents: f.minAmount ? Math.round(Number(f.minAmount) * 100) : undefined, maxCents: f.maxAmount ? Math.round(Number(f.maxAmount) * 100) : undefined });
  async function save() {
    setMsg(""); setTest(null);
    const r = await staffFetch(`/api/settings/paynow${outlet ? `?outlet=${encodeURIComponent(outlet)}` : ""}`, { method: "PUT", body: body() });
    if (!("res" in r)) return setMsg(r.problem);
    if (r.res.ok) { setSaved(true); setMsg("Saved. Press “Show test QR” and scan it with your banking app to check."); void load(); }
    else setMsg(((await r.res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save.");
  }
  async function reset() {
    if (!(await askConfirm({ title: "Remove this outlet’s PayNow?", message: "Take this outlet’s own PayNow away? It will use the shop’s PayNow again.", ok: "Remove", cancel: "Keep" }))) return;
    const r = await staffFetch(`/api/settings/paynow?outlet=${encodeURIComponent(outlet)}`, { method: "PUT", body: { reset: true } });
    if ("res" in r && r.res.ok) { setMsg("This outlet uses the shop’s PayNow again."); void load(); }
  }
  async function showTest() {
    setMsg("");
    const r = await staffFetch(`/api/settings/paynow/test${outlet ? `?outlet=${encodeURIComponent(outlet)}` : ""}`, { method: "POST", body: {} });
    if (!("res" in r)) return setMsg(r.problem);
    if (!r.res.ok) return setMsg("Save the PayNow details first.");
    const j = (await r.res.json()) as { payload: string; expiresAt: number; displayName: string };
    setTest({ img: await QRCode.toDataURL(j.payload, { margin: 4, width: 360 }), name: j.displayName, until: j.expiresAt });
  }
  const ok = f.proxyValue.trim() && f.displayName.trim() && /^[A-Za-z0-9]{2}$/.test(f.outletCode);
  const forOutlet = !!outlet;
  const shopHasNone = forOutlet && !saved && !own;
  // An outlet with nothing of its own shows the shop's setup read-only, with a way to give it its own.
  const editing = !forOutlet || own || editOutlet;

  return (
    <div style={{ marginTop: 24 }}>
      <h3>PayNow</h3>
      <p className="muted">Customers scan a QR that pays this PayNow directly, for the exact amount. Your banking app shows them the name below before they pay.</p>
      {outlets.length > 1 && (
        <label className="field">Setup for<select value={outlet} onChange={(e) => { setOutlet(e.target.value); setEditOutlet(false); }}>
          <option value="">The shop (used by every outlet without its own)</option>
          {outlets.map((o) => <option key={o.id} value={o.id}>{o.name} only</option>)}
        </select></label>
      )}
      {msg && <div className="flash">{msg}</div>}
      {shopHasNone && <div className="flash warn">Set up the shop’s PayNow first (choose “The shop” above). An outlet then only changes what is different, such as its own bank account.</div>}
      {forOutlet && !own && !shopHasNone && !editOutlet && (
        <div className="flash">This outlet uses the shop’s PayNow. <button className="secondary sm" onClick={() => { setEditOutlet(true); setF((x) => ({ ...x, outletCode: "" })); }}>Give this outlet its own</button></div>
      )}
      {forOutlet && (own || editOutlet) && <p className="muted">This outlet has its own PayNow. Fill in what differs; give it its own two-character shop code, so a payment can be traced on the bank statement.</p>}
      <fieldset disabled={!editing || shopHasNone} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="row">
          <label className="field">PayNow to<select value={f.proxyType} onChange={(e) => setF({ ...f, proxyType: e.target.value as Proxy })}><option value="uen">Business (UEN)</option><option value="mobile">Mobile number</option><option value="nric">NRIC / FIN</option><option value="vpa">PayNow address (VPA)</option></select></label>
          <label className="field">PayNow ID<input value={f.proxyValue} onChange={(e) => setF({ ...f, proxyValue: e.target.value })} placeholder={hint[f.proxyType]} /></label>
        </div>
        <div className="row">
          <label className="field">Name customers see (25 letters at most)<input value={f.displayName} maxLength={25} onChange={(e) => setF({ ...f, displayName: e.target.value.toUpperCase() })} placeholder="e.g. BAILEY & PATCH" /></label>
          <label className="field">Shop code (2 letters or digits)<input value={f.outletCode} maxLength={2} onChange={(e) => setF({ ...f, outletCode: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "") })} placeholder="e.g. B1" /></label>
          <label className="field">QR stays valid (minutes)<select value={f.ttlMinutes} onChange={(e) => setF({ ...f, ttlMinutes: e.target.value })}><option>2</option><option>3</option><option>4</option><option>5</option></select></label>
        </div>
        <div className="row">
          <label className="field">Smallest PayNow amount (S$, optional)<input inputMode="decimal" value={f.minAmount} onChange={(e) => setF({ ...f, minAmount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="no limit" /></label>
          <label className="field">Largest PayNow amount (S$, optional)<input inputMode="decimal" value={f.maxAmount} onChange={(e) => setF({ ...f, maxAmount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="no limit" /></label>
        </div>
        <details open={!!f.alertSender || !!f.mailboxId}>
          <summary className="muted">Confirm payments automatically (optional)</summary>
          <p className="muted">The bank emails “funds received” to a mailbox. We read the mailbox only while a QR is open, and mark the order paid. UOB prints the QR’s remarks in its email, so those payments are matched exactly. DBS leaves the remarks out, so its payments are matched by amount and time, which is probable but not certain: staff can always confirm one by hand. Set the bank’s alert to its lowest amount (S$0.01) or small payments send no email. Outlets that pay into the same bank account can share one mailbox; an outlet with its own account says which one below.</p>
          <div className="row">
            <label className="field">Bank alert sender<input value={f.alertSender} onChange={(e) => setF({ ...f, alertSender: e.target.value })} placeholder="e.g. ibanking.alert@dbs.com" /></label>
            <label className="field">Account ends in<input inputMode="numeric" value={f.receivingAccountEnding} maxLength={6} onChange={(e) => setF({ ...f, receivingAccountEnding: e.target.value.replace(/\D/g, "") })} placeholder="last 3 to 6 digits" /></label>
            <label className="field">Mailbox<select value={f.mailboxId} onChange={(e) => setF({ ...f, mailboxId: e.target.value })}>
              <option value="">The server’s own mailbox</option>
              {mail.rows.map((m) => <option key={m.id} value={m.id}>{m.username} ({m.label})</option>)}
            </select></label>
          </div>
        </details>
        <div className="row"><button className="primary sm" disabled={!ok || !editing} onClick={() => void save()}>Save</button>{saved && <button className="secondary sm" type="button" onClick={() => void showTest()}>Show test QR (S$0.01)</button>}{forOutlet && own && <button className="secondary sm" type="button" onClick={() => void reset()}>Use the shop’s PayNow</button>}</div>
      </fieldset>
      {test && (
        <div style={{ marginTop: 12 }}>
          <img src={test.img} alt="Test PayNow QR" width={220} height={220} />
          <p className="muted">Scan with your banking app. It should show <b>{test.name}</b> and S$0.01. Pay it only if you want to try the automatic confirmation; the cent lands under unassigned payments. Valid until {new Date(test.until).toLocaleTimeString()}.</p>
        </div>
      )}
      <MailboxesPanel rows={mail.rows} reload={mail.reload} />
    </div>
  );
}
