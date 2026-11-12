import { useCallback, useEffect, useState } from "react";
import type { Catalog } from "@pos/core";
import { staffFetch, useStaff } from "../auth";

interface Printer {
  id: string;
  name: string;
  language: "escpos" | "zpl" | "epl";
  roles: Array<"receipt" | "kitchen" | "label">;
  categories: string[];
  widthChars: number;
  drawer: boolean;
  raster: boolean;
  labelWidthMm: number | null;
  labelHeightMm: number | null;
  dpi: 203 | 300;
  connection: { host: string; port: number };
  agentDeviceId: string | null;
  active: boolean;
}
interface Job {
  id: string;
  printer_id: string;
  doc_type: string;
  title: string | null;
  status: "queued" | "leased" | "done" | "failed" | "unconfirmed";
  attempts: number;
  last_error: string | null;
  created_at: string;
}
interface DeviceRow {
  id: string;
  name: string;
  active: boolean;
  last_print_poll_at: string | null;
}

type Kind = "receipt" | "kitchen" | "both" | "label";
const KIND_LABEL: Record<Kind, string> = { receipt: "Receipt printer", kitchen: "Kitchen / bar printer", both: "Receipt and kitchen on one printer", label: "Label printer" };
const kindOf = (p: Printer): Kind => (p.roles.includes("label") ? "label" : p.roles.includes("receipt") && p.roles.includes("kitchen") ? "both" : p.roles.includes("kitchen") ? "kitchen" : "receipt");
const rolesOf = (k: Kind): Printer["roles"] => (k === "both" ? ["receipt", "kitchen"] : [k]);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

const blank = (): Printer => ({ id: "", name: "", language: "escpos", roles: ["receipt"], categories: [], widthChars: 42, drawer: false, raster: false, labelWidthMm: null, labelHeightMm: null, dpi: 203, connection: { host: "", port: 9100 }, agentDeviceId: null, active: true });

const STATUS: Record<Job["status"], string> = { queued: "Waiting", leased: "Printing", done: "Printed", failed: "Failed", unconfirmed: "Unconfirmed" };
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

/** Managers and owners: set up printers, check they work, and see (and retry) what did not print. */
export function Printers({ catalog }: { catalog: Catalog }) {
  const staff = useStaff();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [editing, setEditing] = useState<Printer | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, j, d] = await Promise.all([staffFetch("/api/printers"), staffFetch("/api/print/jobs"), staffFetch("/api/devices")]);
    if ("res" in p && p.res.ok) setPrinters(((await p.res.json()) as { printers: Printer[] }).printers);
    if ("res" in j && j.res.ok) setJobs(((await j.res.json()) as { jobs: Job[] }).jobs);
    if ("res" in d && d.res.ok) setDevices(((await d.res.json()) as { devices: DeviceRow[] }).devices.filter((x) => x.active));
  }, []);

  useEffect(() => {
    if (!staff || staff.role === "cashier") return;
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [staff, load]);

  if (!staff || staff.role === "cashier")
    return (
      <div className="credit">
        <h2>Printers</h2>
        <p className="muted">{staff ? "Only managers and owners can set up printers." : "Sign in as a manager or owner to set up printers."} {!staff && <a href="#/login">Sign in</a>}</p>
      </div>
    );

  async function save() {
    if (!editing) return;
    const p = { ...editing, id: isNew ? slug(editing.name) || "printer" : editing.id };
    const body = { ...p, categories: p.roles.includes("label") || p.roles.includes("kitchen") ? p.categories : [], drawer: p.roles.includes("receipt") && p.drawer, raster: p.roles.includes("label") ? false : p.raster };
    const r = await staffFetch(`/api/printers/${p.id}`, { method: "PUT", body });
    if ("problem" in r) return setMsg(r.problem);
    if (!r.res.ok) {
      const j = (await r.res.json().catch(() => ({}))) as { problems?: string[] };
      return setMsg(`Not saved: ${j.problems?.join("; ") ?? r.res.status}`);
    }
    setMsg(`${p.name} saved.`);
    setEditing(null);
    void load();
  }

  async function testPage(p: Printer) {
    const r = await staffFetch(`/api/printers/${p.id}/test`, { method: "POST", body: {} });
    setMsg("problem" in r ? r.problem : r.res.ok ? `Test page queued for ${p.name}. It prints within a few seconds if the printer is reachable.` : "Could not queue a test page.");
    void load();
  }

  async function setActive(p: Printer, active: boolean) {
    const r = await staffFetch(`/api/printers/${p.id}`, { method: "PUT", body: { ...p, active } });
    setMsg("problem" in r ? r.problem : r.res.ok ? `${p.name} ${active ? "switched on" : "switched off"}.` : "Could not change that printer.");
    void load();
  }

  async function retry(j: Job) {
    const r = await staffFetch(`/api/print/jobs/${j.id}/retry`, { method: "POST", body: {} });
    setMsg("problem" in r ? r.problem : r.res.ok ? "Queued to try again." : "That job can't be retried.");
    void load();
  }

  // A print hub checks in every couple of seconds. Quiet for more than 20 seconds means it is not running or cannot reach us.
  const hubs = devices.filter((d) => d.last_print_poll_at).map((d) => ({ d, secs: Math.max(0, Math.round((Date.now() - new Date(d.last_print_poll_at!).getTime()) / 1000)) }));
  const liveHubs = hubs.filter((h) => h.secs <= 20);
  const ago = (s: number) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
  const failed = jobs.filter((j) => j.status === "failed");
  const unconfirmed = jobs.filter((j) => j.status === "unconfirmed");
  const nameOf = (id: string) => printers.find((p) => p.id === id)?.name ?? id;
  const cats = [...new Set(catalog.products.map((p) => p.category))];
  const kind = editing ? kindOf(editing) : "receipt";
  const set = (patch: Partial<Printer>) => setEditing((e) => (e ? { ...e, ...patch } : e));

  return (
    <div className="credit prices">
      <h2>Printers</h2>
      {msg && <div className="flash">{msg}</div>}
      {hubs.length === 0 ? (
        <div className="flash warn">No print hub has connected yet, so nothing can print. Set one up (see the setup guide), then it shows here.</div>
      ) : liveHubs.length === 0 ? (
        <div className="flash warn">Print hub offline: {hubs[0]!.d.name} was last seen {ago(hubs[0]!.secs)} ago. Orders will wait and print when it is back. Check the tablet is on, charged and online, and that the hub is still running.</div>
      ) : (
        <div className="flash">Print hub online: {liveHubs.map((h) => h.d.name).join(", ")}.</div>
      )}
      {unconfirmed.length > 0 && (
        <div className="flash warn">{unconfirmed.length} print job{unconfirmed.length > 1 ? "s" : ""} unconfirmed: the printer may already have printed {unconfirmed.length > 1 ? "them" : "it"}. Look at the printer, then press Reprint only if nothing came out.</div>
      )}
      {failed.length > 0 && (
        <div className="flash warn">{failed.length} print job{failed.length > 1 ? "s" : ""} failed. Check the printer is on, has paper and is on the network, then retry below.</div>
      )}

      {printers.length === 0 && !editing && <p className="muted">No printers yet. Add one to start printing receipts and kitchen tickets.</p>}
      {printers.map((p) => (
        <div className="tab" key={p.id}>
          <div>
            <b>{p.name}</b> {!p.active && <span className="muted">· off</span>}
            <div className="muted">
              {KIND_LABEL[kindOf(p)]} · {p.connection.host}:{p.connection.port}
              {p.categories.length ? ` · only ${p.categories.join(", ")}` : ""}
            </div>
          </div>
          <div className="tabr">
            <button className="secondary sm" disabled={!p.active} onClick={() => void testPage(p)}>Test page</button>
            <button className="secondary sm" onClick={() => { setEditing(p); setIsNew(false); }}>Edit</button>
            <button className="secondary sm" onClick={() => void setActive(p, !p.active)}>{p.active ? "Switch off" : "Switch on"}</button>
          </div>
        </div>
      ))}
      {!editing && <button className="primary" onClick={() => { setEditing(blank()); setIsNew(true); setMsg(null); }}>Add a printer</button>}

      {editing && (
        <div className="editor">
          <h3>{isNew ? "New printer" : `Edit ${editing.name}`}</h3>
          <label className="field">Name (e.g. Front receipt, Kitchen, Bar)<input value={editing.name} onChange={(e) => set({ name: e.target.value })} /></label>
          <label className="field">
            What is it for?
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value as Kind;
                set({ roles: rolesOf(k), language: k === "label" ? "zpl" : "escpos", labelWidthMm: k === "label" ? 50 : null, labelHeightMm: k === "label" ? 30 : null });
              }}
            >
              {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <div className="row">
            <label className="field grow">Printer address (IP or name)<input value={editing.connection.host} placeholder="192.168.1.50" onChange={(e) => set({ connection: { ...editing.connection, host: e.target.value.trim() } })} /></label>
            <label className="field">Port<input inputMode="numeric" value={editing.connection.port} onChange={(e) => set({ connection: { ...editing.connection, port: Number(e.target.value.replace(/\D/g, "")) || 0 } })} /></label>
          </div>
          {kind !== "label" && (
            <label className="field">Paper width<select value={editing.widthChars} onChange={(e) => set({ widthChars: Number(e.target.value) })}><option value={32}>58 mm (32 characters)</option><option value={42}>80 mm (42 characters)</option><option value={48}>80 mm, small font (48 characters)</option></select></label>
          )}
          {kind !== "label" && (
            <label className="inline"><input type="checkbox" checked={editing.raster} onChange={(e) => set({ raster: e.target.checked })} /> Print as a picture (Chinese, Tamil and logos; a little slower)</label>
          )}
          {(kind === "receipt" || kind === "both") && (
            <label className="inline"><input type="checkbox" checked={editing.drawer} onChange={(e) => set({ drawer: e.target.checked })} /> Open the cash drawer for cash sales</label>
          )}
          {kind === "label" && (
            <>
              <div className="row">
                <label className="field">Printer language<select value={editing.language} onChange={(e) => set({ language: e.target.value as Printer["language"] })}><option value="zpl">ZPL (most Zebra)</option><option value="epl">EPL (older Zebra/Eltron)</option></select></label>
                <label className="field">Label width (mm)<input inputMode="numeric" value={editing.labelWidthMm ?? ""} onChange={(e) => set({ labelWidthMm: Number(e.target.value.replace(/\D/g, "")) || null })} /></label>
                <label className="field">Label height (mm)<input inputMode="numeric" value={editing.labelHeightMm ?? ""} onChange={(e) => set({ labelHeightMm: Number(e.target.value.replace(/\D/g, "")) || null })} /></label>
                <label className="field">Resolution<select value={editing.dpi} onChange={(e) => set({ dpi: Number(e.target.value) as 203 | 300 })}><option value={203}>203 dpi</option><option value={300}>300 dpi</option></select></label>
              </div>
            </>
          )}
          {(kind === "kitchen" || kind === "both" || kind === "label") && (
            <fieldset className="cats">
              <legend>Only print these categories (leave all unticked for everything not claimed by another printer)</legend>
              {cats.map((c) => (
                <label className="inline" key={c}>
                  <input type="checkbox" checked={editing.categories.includes(c)} onChange={(e) => set({ categories: e.target.checked ? [...editing.categories, c] : editing.categories.filter((x) => x !== c) })} /> {c}
                </label>
              ))}
            </fieldset>
          )}
          <label className="field">
            Delivered by
            <select value={editing.agentDeviceId ?? ""} onChange={(e) => set({ agentDeviceId: e.target.value || null })}>
              <option value="">Any hub or print agent</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <div className="row">
            <button className="primary sm" disabled={!editing.name.trim() || !editing.connection.host || !editing.connection.port} onClick={() => void save()}>Save</button>
            <button className="secondary sm" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      <h3>Recent print jobs</h3>
      {jobs.length === 0 && <p className="muted">Nothing has been queued yet.</p>}
      {jobs.slice(0, 40).map((j) => (
        <div className={`job ${j.status}`} key={j.id}>
          <span className="badge">{STATUS[j.status]}</span>
          <span className="nm"><b>{j.title ?? "—"}</b> · {j.doc_type} · {nameOf(j.printer_id)}</span>
          <span className="muted">{timeOf(j.created_at)}{j.attempts > 1 ? ` · try ${j.attempts}` : ""}</span>
          {j.last_error && j.status !== "done" && <span className="err">{j.last_error}</span>}
          {j.status === "failed" && <button className="secondary sm" onClick={() => void retry(j)}>Retry</button>}
          {j.status === "unconfirmed" && <button className="secondary sm" onClick={() => void retry(j)}>Reprint</button>}
        </div>
      ))}
    </div>
  );
}
