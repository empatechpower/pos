import { useEffect, useRef, useState } from "react";
import { formatMoney, type BusinessConfig, type OrderState } from "@pos/core";
import type { FloorSettings, FloorTable } from "../floor";
import { Modal } from "./Modal";
import { clearTable, courseProgress, isBarTab, isSeatedOrder, mergeProblem, minutesSince, orderBrief, tabLabel, tableInfo, type TableInfo, type TableState } from "./tableOps";
import type { HeldOrder } from "./types";

const LEGEND: Array<[TableState, string]> = [["available", "Available"], ["seated", "Seated"], ["ordered", "Ordered"], ["bill", "Bill asked"], ["paid", "Paid · to clear"], ["overdue", "Overdue"]];

type Pick = null | { kind: "transfer" | "merge"; from: OrderState };

/**
 * The Table Map: the floor (or a list), and the bar tabs. Tap a table to open its bill; press and hold an occupied one for Open order /
 * Transfer / Merge / Fire Course / guest check. Statuses have colours and a legend; every occupied table shows two timers (since seated, since the last order was sent).
 */
export function TableMap(p: {
  floor: FloorSettings; config: BusinessConfig; orders: OrderState[]; held: HeldOrder[]; courses: boolean; canTransfer: boolean;
  onOpen: (name: string) => void; onNewTab: (name: string) => void;
  onTransfer: (o: OrderState, to: string) => Promise<void>; onMerge: (from: OrderState, into: OrderState) => Promise<string | null>;
  staffName?: string;
  onFire: (o: OrderState) => Promise<void>; onBill: (o: OrderState) => Promise<void>; onBack: () => void;
  /** Managers can arrange the floor: drag tables, change their shape, add and remove them. */
  canArrange?: boolean; onSaveFloor?: (patch: Partial<FloorSettings>) => Promise<string | null>;
}) {
  const [seg, setSeg] = useState<"floor" | "tabs">("floor");
  const [layout, setLayout] = useState<"floor" | "list">("floor");
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(t); }, []);
  const [menu, setMenu] = useState<TableInfo | null>(null);
  const [pick, setPick] = useState<Pick>(null);
  const [confirm, setConfirm] = useState<null | { from: OrderState; into: OrderState }>(null);
  const [msg, setMsg] = useState("");
  const [search, setSearch] = useState("");
  const [newTab, setNewTab] = useState<null | string>(null);
  const [secIx, setSecIx] = useState(0);
  const [arrange, setArrange] = useState(false);
  const [drag, setDrag] = useState<null | { name: string; x: number; y: number }>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const hold = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  // A long press that opened the menu must not also count as a tap once the menu is gone.
  useEffect(() => { if (!menu) hold.current.fired = false; }, [menu]);
  const info = (name: string) => tableInfo(name, p.orders, p.held, p.config, p.floor, now);

  const press = (t: TableInfo) => ({
    onPointerDown: () => { hold.current.fired = false; if (t.order && !pick) hold.current.timer = window.setTimeout(() => { hold.current.fired = true; setMenu(t); }, 600); },
    onPointerUp: () => { if (hold.current.timer) window.clearTimeout(hold.current.timer); },
    onPointerLeave: () => { if (hold.current.timer) window.clearTimeout(hold.current.timer); },
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (t.order && !pick) setMenu(t); },
    onClick: () => { if (hold.current.fired) { hold.current.fired = false; return; } tap(t); },
  });

  function tap(t: TableInfo) {
    setMsg("");
    if (t.state === "paid" && t.paidOrder) {
      if (pick) return setMsg(`${t.name} is paid and waiting to be cleared.`);
      void clearTable(t.paidOrder, p.staffName).then(() => setMsg(`${t.name} cleared · table is free`));
      return;
    }
    if (!pick) return p.onOpen(t.name);
    if (pick.kind === "transfer") {
      if (t.state !== "available") return setMsg(t.order ? `${t.name} already has an order: use Merge tables instead.` : `${t.name} has a draft order on it. Open it first.`);
      void p.onTransfer(pick.from, t.name).then(() => { setPick(null); setMsg(`Moved to ${t.name}.`); });
      return;
    }
    if (!t.order) return setMsg("Pick another table that has an order.");
    const bad = mergeProblem(pick.from, t.order);
    if (bad) return setMsg(bad);
    setConfirm({ from: pick.from, into: t.order });
  }

  const cell = (name: string, extra?: string, label?: string) => {
    const t = info(name);
    const dim = pick && (pick.kind === "transfer" ? t.state !== "available" : !t.order || t.order.orderId === pick.from.orderId);
    const go = pick?.kind === "transfer" && t.state === "available";
    return (
      <button key={name} className={`t-table s-${t.state} ${t.level ? `ring${t.level}` : ""} ${dim ? "dim" : ""} ${go ? "go" : ""}`} aria-label={`${name}: ${t.state}`} {...press(t)}>
        <strong>{label ?? name}</strong>
        {extra && <small>{extra}</small>}
        {t.state !== "available" && (
          <span className="t-ttimes"><i title="Since seated">⏱ {minutesSince(t.seatedAt, now)}</i>{t.order && <i title="Since the last order was sent">▶ {minutesSince(t.lastSentAt, now)}</i>}</span>
        )}
        {t.totalCents !== undefined && <b>{formatMoney(t.totalCents)}</b>}
        {t.guests ? <em>{t.guests} 👤</em> : null}
      </button>
    );
  };

  const sec = p.floor.sections[Math.min(secIx, p.floor.sections.length - 1)]!;
  const secTables = sec.tables.filter((t) => !isBarTab(t.name));
  /** A table with no saved place gets one on a tidy grid, so a floor nobody has arranged still looks like a floor. */
  const placed = (t: FloorTable, i: number): { x: number; y: number } => {
    if (t.x !== undefined && t.y !== undefined) return { x: t.x, y: t.y };
    const cols = 4, rows = Math.max(1, Math.ceil(secTables.length / cols)), rowH = Math.min(30, 80 / rows);
    return { x: 5 + (i % cols) * 23, y: 6 + Math.floor(i / cols) * rowH };
  };
  const floorTables = secTables.map((t, i) => ({ ...t, ...placed(t, i), shape: t.shape ?? "rect" }));
  const stateLine = (t: TableInfo) => t.state === "paid" ? <small>Paid · to clear</small> : t.order || t.draft ? <><small>Seated {minutesSince(t.seatedAt, now)}m</small>{t.order && t.state !== "bill" && <small>Sent {minutesSince(t.lastSentAt, now)}m ago</small>}{t.state === "bill" && <small>Bill asked</small>}</> : <small>Available</small>;
  const floorCell = (t: FloorTable & { x: number; y: number; shape: string }) => {
    const i = info(t.name);
    const dim = pick && (pick.kind === "transfer" ? i.state !== "available" : !i.order || i.order.orderId === pick.from.orderId);
    const go = pick?.kind === "transfer" && i.state === "available";
    return (
      <button key={t.id} className={`t-ftable ${t.shape} s-${i.state} ${i.level ? `ring${i.level}` : ""} ${dim ? "dim" : ""} ${go ? "go" : ""}`} style={{ left: `${t.x}%`, top: `${t.y}%` }} aria-label={`${t.name}: ${i.state}`} {...press(i)}>
        <strong>{t.name}</strong>{stateLine(i)}{i.totalCents !== undefined && <b>{formatMoney(i.totalCents)}</b>}
      </button>
    );
  };
  const sectionsWith = (fn: (ts: FloorTable[]) => FloorTable[]) => p.floor.sections.map((x) => x.id === sec.id ? { ...x, tables: fn(x.tables) } : x);
  const saveTables = async (fn: (ts: FloorTable[]) => FloorTable[]) => { const e = await p.onSaveFloor?.({ sections: sectionsWith(fn) }); if (e) setMsg(e); };
  /** Save every table's place at once, so tables that were only placed by default stay where they were drawn. */
  const settle = (ts: FloorTable[], over?: { name: string; x: number; y: number }) => ts.map((t) => { if (isBarTab(t.name)) return t; const i = secTables.findIndex((q) => q.id === t.id); const pos = over && over.name === t.name ? over : placed(t, i); return { ...t, x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10 }; });
  const dragStart = (t: { name: string; x: number; y: number }, e: React.PointerEvent) => {
    const box = canvas.current?.getBoundingClientRect(); if (!box) return;
    const start = { px: e.clientX, py: e.clientY, x: t.x, y: t.y };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => setDrag({ name: t.name, x: Math.min(92, Math.max(0, start.x + ((ev.clientX - start.px) / box.width) * 100)), y: Math.min(88, Math.max(0, start.y + ((ev.clientY - start.py) / box.height) * 100)) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      const x = Math.min(92, Math.max(0, start.x + ((ev.clientX - start.px) / box.width) * 100)), y = Math.min(88, Math.max(0, start.y + ((ev.clientY - start.py) / box.height) * 100));
      setDrag(null);
      if (Math.abs(ev.clientX - start.px) + Math.abs(ev.clientY - start.py) > 3) void saveTables((ts) => settle(ts, { name: t.name, x, y }));
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  const arrangeCell = (t: FloorTable & { x: number; y: number; shape: string }) => {
    const at = drag && drag.name === t.name ? drag : t;
    const taken = !!info(t.name).order || !!info(t.name).draft;
    return (
      <div key={t.id} className={`t-ftable arr ${t.shape} s-available`} style={{ left: `${at.x}%`, top: `${at.y}%` }} onPointerDown={(e) => dragStart(t, e)} aria-label={`Move ${t.name}`}>
        <strong>{t.name}</strong><small>{t.seats ? `${t.seats} seats` : "Drag me"}</small>
        <span className="t-ftools">
          <button aria-label={`Change shape of ${t.name}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => void saveTables((ts) => settle(ts).map((q) => q.id === t.id ? { ...q, shape: t.shape === "rect" ? "round" : t.shape === "round" ? "oval" : "rect" } : q))}>⟳</button>
          <button aria-label={`Remove ${t.name}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => { if (taken) return setMsg(`${t.name} has an order on it: settle it before removing the table.`); void saveTables((ts) => ts.filter((q) => q.id !== t.id)); }}>×</button>
        </span>
      </div>
    );
  };
  const addTable = async () => {
    const all = p.floor.sections.flatMap((x) => x.tables.map((t) => t.name));
    let n = all.length + 1; while (all.includes(`Table ${n}`)) n++;
    await saveTables((ts) => [...settle(ts), { id: `t${Date.now().toString(36)}`, name: `Table ${n}`, seats: 4, shape: "rect", x: 12, y: 30 }]);
  };

  const tabs = [
    ...new Set([
      ...p.orders.filter((o) => isBarTab(o.spot) && isSeatedOrder(o, p.config)).map((o) => o.spot!),
      ...p.held.filter((h) => isBarTab(h.spot)).map((h) => h.spot),
    ]),
  ].filter((n) => !search || n.toLowerCase().includes(search.toLowerCase()));

  return (
    <section className="t-tablemap" aria-label="Table map">
      <div className="t-tmhead">
        <button className="t-ghost" onClick={p.onBack}>← Order screen</button>
        <div className="t-seg" role="tablist"><button role="tab" aria-selected={seg === "floor"} className={seg === "floor" ? "on" : ""} onClick={() => setSeg("floor")}>Table Map</button><button role="tab" aria-selected={seg === "tabs"} className={seg === "tabs" ? "on" : ""} onClick={() => setSeg("tabs")}>Bar Tabs</button></div>
        {seg === "floor" && <div className="t-seg"><button className={layout === "floor" ? "on" : ""} onClick={() => setLayout("floor")}>Floor</button><button className={layout === "list" ? "on" : ""} onClick={() => setLayout("list")}>List</button></div>}
      </div>
      {pick && <div className="t-banner" role="status">{pick.kind === "transfer" ? `Moving ${pick.from.spot}: tap a free table (green outline).` : `Merging ${pick.from.spot}: tap the table whose bill it joins.`} <button className="t-link" onClick={() => { setPick(null); setMsg(""); }}>Cancel</button></div>}
      {msg && <div className="t-flash" role="status">{msg}</div>}
      {seg === "floor" ? (
        <>
          {p.floor.sections.length > 1 && <div className="t-seg t-secs" role="tablist" aria-label="Sections">{p.floor.sections.map((x, i) => <button key={x.id} role="tab" aria-selected={sec.id === x.id} className={sec.id === x.id ? "on" : ""} onClick={() => setSecIx(i)}>{x.name}</button>)}</div>}
          {layout === "floor" && p.canArrange && <div className="t-arrangebar"><label><input type="checkbox" checked={arrange} onChange={(e) => setArrange(e.target.checked)} /> Arrange</label>{arrange && <><button className="t-ghost" onClick={() => void addTable()}>＋ Table</button><span className="t-muted">Drag a table into place. ⟳ changes its shape, × removes it.</span></>}</div>}
          {layout === "floor" ? (
            <div className={`t-canvas ${arrange ? "arranging" : ""}`} ref={canvas}>
              {floorTables.length === 0 && <p className="t-muted t-empty">No tables in this section.</p>}
              {floorTables.map((t) => arrange ? arrangeCell(t) : floorCell(t))}
            </div>
          ) : (
            <div className="t-tlist">
              {floorTables.map((t) => { const i = info(t.name); return (
                <button key={t.id} className={`t-trow s-${i.state}`} {...press(i)}>
                  <i className={`dot s-${i.state}`} /><strong>{t.name}</strong><span>{LEGEND.find((x) => x[0] === i.state)![1]}</span>
                  <span>{i.state === "available" ? "" : `⏱ ${minutesSince(i.seatedAt, now)}${i.order ? ` · ▶ ${minutesSince(i.lastSentAt, now)}` : ""}`}</span><b>{i.totalCents !== undefined ? formatMoney(i.totalCents) : ""}</b>
                </button>
              ); })}
            </div>
          )}
          <div className="t-legend" aria-label="Legend">{LEGEND.map(([s, l]) => <span key={s}><i className={`dot s-${s}`} />{l}</span>)}</div>
          <p className="t-muted t-foot">Each table shows time since seated and, once food is sent, time since the last order was sent.</p>
        </>
      ) : (
        <div className="t-tabsarea">
          <div className="t-tabtools"><input placeholder="Search tabs" aria-label="Search tabs" value={search} onChange={(e) => setSearch(e.target.value)} /><button className="t-primary" onClick={() => setNewTab("")}>＋ New Tab</button></div>
          {tabs.length === 0 ? <p className="t-muted">No open tabs. Start one with New Tab.</p> : <div className="t-tgrid wide">{tabs.map((n) => { const i = info(n); void i; return cell(n, "Bar tab", tabLabel(n)); })}</div>}
        </div>
      )}

      {menu?.order && (
        <Modal title={menu.name} onClose={() => setMenu(null)}>
          <p className="t-muted">{orderBrief(menu.order, p.config)}</p>
          <div className="t-menulist">
            <button onClick={() => { const n = menu.name; setMenu(null); p.onOpen(n); }}>Open order</button>
            {p.canTransfer && <button onClick={() => { setPick({ kind: "transfer", from: menu.order! }); setMenu(null); setMsg(""); }}>Transfer table…</button>}
            {p.canTransfer && <button onClick={() => { setPick({ kind: "merge", from: menu.order! }); setMenu(null); setMsg(""); }}>Merge tables…</button>}
            {p.courses && courseProgress(menu.order) && <button onClick={() => { const o = menu.order!; setMenu(null); void p.onFire(o); }}>Fire Course ({courseProgress(menu.order)!.index} of {courseProgress(menu.order)!.of})</button>}
            <button onClick={() => { const o = menu.order!; setMenu(null); void p.onBill(o); }}>Print guest check</button>
            <button className="t-ghost" onClick={() => setMenu(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal title="Merge tables" onClose={() => setConfirm(null)}>
          <p><b>{confirm.from.spot}</b> ({orderBrief(confirm.from, p.config)}) joins <b>{confirm.into.spot}</b> ({orderBrief(confirm.into, p.config)}).</p>
          <p className="t-muted">{confirm.into.spot} keeps the bill and {confirm.from.spot} is freed. This cannot be undone.</p>
          <div className="t-dact"><button className="t-ghost" onClick={() => { setConfirm(null); setPick(null); }}>Cancel</button><button className="t-primary" onClick={() => { const c = confirm; setConfirm(null); void p.onMerge(c.from, c.into).then((e) => { setPick(null); setMsg(e ?? `${c.from.spot} merged into ${c.into.spot}.`); }); }}>Merge</button></div>
        </Modal>
      )}
      {newTab !== null && (
        <Modal title="New bar tab" onClose={() => setNewTab(null)}>
          <label className="t-field">Guest name or tab number<input autoFocus value={newTab} onChange={(e) => setNewTab(e.target.value)} maxLength={20} /></label>
          <div className="t-dact"><button className="t-ghost" onClick={() => setNewTab(null)}>Cancel</button><button className="t-primary" disabled={!newTab.trim()} onClick={() => { const n = `Tab ${newTab.trim()}`; setNewTab(null); p.onNewTab(n); }}>Start tab</button></div>
        </Modal>
      )}
    </section>
  );
}
