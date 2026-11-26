import { useEffect, useRef, useState } from "react";
import { formatMoney, type BusinessConfig, type OrderState } from "@pos/core";
import type { FloorSettings, FloorTable } from "../floor";
import { ProtoModal } from "../proto/ProtoDialog";
import { clearTable, courseProgress, isBarTab, isSeatedOrder, mergeProblem, orderBrief, tabLabel, tableInfo, type TableInfo } from "./tableOps";
import type { HeldOrder } from "./types";

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
  // On a phone the floor is too narrow to read at a glance: the map opens as a list there (Floor is one tap away, and can be panned).
  const [layout, setLayout] = useState<"floor" | "list">(() => (window.innerWidth < 700 ? "list" : "floor"));
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

  const sec = p.floor.sections[Math.min(secIx, p.floor.sections.length - 1)]!;
  const secTables = sec.tables.filter((t) => !isBarTab(t.name));
  /** A table with no saved place gets one on a tidy grid, so a floor nobody has arranged still looks like a floor. */
  const placed = (t: FloorTable, i: number): { x: number; y: number } => {
    if (t.x !== undefined && t.y !== undefined) return { x: t.x, y: t.y };
    const cols = 4, rows = Math.max(1, Math.ceil(secTables.length / cols)), rowH = Math.min(30, 80 / rows);
    return { x: 5 + (i % cols) * 23, y: 6 + Math.floor(i / cols) * rowH };
  };
  const floorTables = secTables.map((t, i) => ({ ...t, ...placed(t, i), shape: t.shape ?? "rect" }));
  /** The prototype's four table colours. A table whose bill was asked for, or that has sat too long, is one of them with a mark on top. */
  const st = (i: TableInfo) => (i.state === "available" ? "free" : i.state === "paid" ? "paid" : i.state === "seated" ? "seated" : i.state === "overdue" && !i.order ? "seated" : "ordered");
  const marks = (i: TableInfo) => `${i.state === "overdue" || i.level ? "overdue" : ""} ${i.state === "bill" ? "st-bill" : ""}`;
  const picking = (i: TableInfo) => (!pick ? "" : i.order?.orderId === pick.from.orderId ? "picksrc" : (pick.kind === "transfer" ? i.state === "available" : !!i.order) ? "pickok" : "pickno");
  const dur = (at: number | undefined) => { const m = Math.max(0, Math.floor((now - (at ?? now)) / 60000)); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : `${m}m`; };
  const stateLine = (i: TableInfo) => i.state === "paid" ? <small>Paid · to clear</small> : i.order || i.draft ? <><small>Seated {dur(i.seatedAt)}</small>{i.order && i.state !== "bill" && <small>Sent {dur(i.lastSentAt)} ago</small>}{i.state === "bill" && <small>Bill asked</small>}</> : <small>Available</small>;
  const floorCell = (t: FloorTable & { x: number; y: number; shape: string }) => {
    const i = info(t.name);
    const h = press(i);
    return (
      <div key={t.id} role="button" tabIndex={0} className={`ftable ${t.shape} st-${st(i)} ${marks(i)} ${picking(i)}`} style={{ left: `${t.x}%`, top: `${t.y}%` }} data-tname={t.name} aria-label={`${t.name}: ${i.state}`} {...h} onKeyDown={(e) => { if (e.key === "Enter") tap(i); }}>
        <strong>{t.name}</strong>{stateLine(i)}
      </div>
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
      <div key={t.id} className={`ftable arr ${t.shape} st-free`} style={{ left: `${at.x}%`, top: `${at.y}%` }} onPointerDown={(e) => dragStart(t, e)} aria-label={`Move ${t.name}`}>
        <strong>{t.name}</strong><small>{t.seats ? `${t.seats} seats` : "Drag me"}</small>
        <span className="ftools">
          <button title="Change shape" aria-label={`Change shape of ${t.name}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => void saveTables((ts) => settle(ts).map((q) => q.id === t.id ? { ...q, shape: t.shape === "rect" ? "round" : t.shape === "round" ? "oval" : "rect" } : q))}>⟳</button>
          <button title="Remove table" aria-label={`Remove ${t.name}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => { if (taken) return setMsg(`${t.name} has an order on it: settle it before removing the table.`); void saveTables((ts) => ts.filter((q) => q.id !== t.id)); }}>×</button>
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

  const LABEL: Record<string, string> = { free: "Available", seated: "Seated", ordered: "Ordered", paid: "Paid · to clear" };
  // The markup and class names are the prototype's own (proto-reference/index.html: renderFloor, renderTabs), styled by its stylesheet.
  return (
    <section className="proto protohead floorwrap" aria-label="Table map">
      <div className="tmseg" role="tablist"><button role="tab" aria-selected={seg === "floor"} className={seg === "floor" ? "selected" : ""} onClick={() => setSeg("floor")}>Table Map</button><button role="tab" aria-selected={seg === "tabs"} className={seg === "tabs" ? "selected" : ""} onClick={() => setSeg("tabs")}>Bar Tabs</button></div>
      {pick && <div className="pickbanner" role="status"><span>{pick.kind === "transfer" ? <>Moving the order on <strong>{pick.from.spot}</strong> — tap a free table</> : <>Merging <strong>{pick.from.spot}</strong> — tap the table whose bill it joins</>}</span><button onClick={() => { setPick(null); setMsg(""); }}>Cancel</button></div>}
      {msg && <div className="floormsg" role="status">{msg}</div>}
      {seg === "floor" ? (
        <>
          <div className="floortools">
            <div className="choices" role="tablist" aria-label="Sections">{p.floor.sections.map((x, i) => <button key={x.id} role="tab" aria-selected={sec.id === x.id} className={sec.id === x.id ? "selected" : ""} onClick={() => setSecIx(i)}>{x.name}</button>)}</div>
            <div className="choices"><button className={layout === "floor" ? "selected" : ""} onClick={() => setLayout("floor")}>Floor</button><button className={layout === "list" ? "selected" : ""} onClick={() => { setLayout("list"); setArrange(false); }}>List</button></div>
            {layout === "floor" && p.canArrange && <label className="arrangelabel"><input type="checkbox" checked={arrange} onChange={(e) => setArrange(e.target.checked)} /> Arrange</label>}
            {layout === "floor" && arrange && <button onClick={() => void addTable()}>+ Table</button>}
          </div>
          {layout === "floor" ? (
            <div className="floorscroll">
            <main className={`floorcanvas ${arrange ? "arranging" : ""}`} ref={canvas}>
              {floorTables.length === 0 && <p className="muted" style={{ padding: "1em" }}>No tables in this section.</p>}
              {floorTables.map((t) => arrange ? arrangeCell(t) : floorCell(t))}
            </main>
            </div>
          ) : (
            <main className="floorlist">
              {floorTables.length === 0 && <p className="muted" style={{ padding: "1em" }}>No tables in this section.</p>}
              {floorTables.map((t) => { const i = info(t.name); return (
                <button key={t.id} className={`frow ${picking(i)}`} data-tname={t.name} {...press(i)}>
                  <strong>{t.name}</strong><span className={`fstate stxt-${st(i)}`}>{i.state === "bill" ? "Bill asked" : LABEL[st(i)]}</span>
                  <span>{i.order || i.draft ? `Seated ${dur(i.seatedAt)}` : ""}</span><span>{i.order && i.state !== "paid" ? `Sent ${dur(i.lastSentAt)} ago` : ""}</span><span>{i.totalCents !== undefined ? formatMoney(i.totalCents) : ""}</span>
                </button>
              ); })}
            </main>
          )}
          <footer className="legend" aria-label="Legend">
            <span><i className="dot dfree" />Available</span><span><i className="dot dseated" />Seated</span><span><i className="dot dordered" />Ordered</span><span><i className="dot dbill" />Bill asked</span><span><i className="dot dpaid" />Paid · to clear</span><span><i className="dot dover" />Seated over {p.floor.overdueMinutes ?? 90} min</span>
            <span className="legnote">Each table shows time since seated, and — once food is sent — time since the last order was sent.</span>
          </footer>
        </>
      ) : (
        <>
          <div className="tabtools"><input type="text" placeholder="Search tabs by name" aria-label="Search tabs" value={search} onChange={(e) => setSearch(e.target.value)} /><button className="primary" onClick={() => setNewTab("")}>+ New Tab</button></div>
          <main className="tabgrid">
            {tabs.length === 0 && <p className="muted" style={{ padding: "1.125em" }}>No open tabs yet — open one with New Tab.</p>}
            {tabs.map((n) => { const i = info(n); const items = i.order ? i.order.lines.reduce((a, l) => a + l.qty, 0) : i.draft ? i.draft.bag.reduce((a, l) => a + l.qty, 0) : 0; const long = now - (i.seatedAt ?? now) > 60 * 60000; return (
              <button key={n} className={`tabcard ${i.order ? "tordered" : ""} ${long ? "tlong" : ""}`} data-tabname={n} {...press(i)}>
                <strong>{tabLabel(n)}</strong><small>{items} items · open {dur(i.seatedAt)}</small><span className="tabtotal">{formatMoney(i.totalCents ?? 0)}</span><small>{i.order ? "Ordered" : "Open"}</small>
              </button>
            ); })}
          </main>
          <footer className="legend"><span><i className="dot dseated" />Open</span><span><i className="dot dordered" />Ordered</span><span><i className="dot dover" />Open over 60 min</span></footer>
        </>
      )}

      {menu?.order && (
        <ProtoModal title={menu.name} onClose={() => setMenu(null)}>
          <p className="muted">{orderBrief(menu.order, p.config)}</p>
          <div className="settingsgroup">
            <button className="primary" onClick={() => { const n = menu.name; setMenu(null); p.onOpen(n); }}>Open order</button>
            {p.canTransfer && <button onClick={() => { setPick({ kind: "transfer", from: menu.order! }); setMenu(null); setMsg(""); }}>Transfer table…</button>}
            {p.canTransfer && <button onClick={() => { setPick({ kind: "merge", from: menu.order! }); setMenu(null); setMsg(""); }}>Merge tables…</button>}
            {p.courses && courseProgress(menu.order) && <button onClick={() => { const o = menu.order!; setMenu(null); void p.onFire(o); }}>Fire Course ({courseProgress(menu.order)!.index} of {courseProgress(menu.order)!.of})</button>}
            <button onClick={() => { const o = menu.order!; setMenu(null); void p.onBill(o); }}>Print guest check</button>
            <button onClick={() => setMenu(null)}>Cancel</button>
          </div>
        </ProtoModal>
      )}
      {confirm && (
        <ProtoModal title="Merge tables?" onClose={() => setConfirm(null)}>
          <p>Move everything on <strong>{confirm.from.spot}</strong> ({orderBrief(confirm.from, p.config)}) into <strong>{confirm.into.spot}</strong> ({orderBrief(confirm.into, p.config)})?</p>
          <p className="muted" style={{ marginTop: "0.5em" }}>{confirm.from.spot} becomes free. This cannot be undone.</p>
          <div className="actions"><button onClick={() => { setConfirm(null); setPick(null); }}>Cancel</button><button className="primary" onClick={() => { const c = confirm; setConfirm(null); void p.onMerge(c.from, c.into).then((e) => { setPick(null); setMsg(e ?? `${c.from.spot} merged into ${c.into.spot}.`); }); }}>Merge tables</button></div>
        </ProtoModal>
      )}
      {newTab !== null && (
        <ProtoModal title="New bar tab" onClose={() => setNewTab(null)}>
          <label className="field">Guest name or tab number<input autoFocus value={newTab} onChange={(e) => setNewTab(e.target.value)} maxLength={20} /></label>
          <div className="actions"><button onClick={() => setNewTab(null)}>Cancel</button><button className="primary" disabled={!newTab.trim()} onClick={() => { const n = `Tab ${newTab.trim()}`; setNewTab(null); p.onNewTab(n); }}>Open tab</button></div>
        </ProtoModal>
      )}
    </section>
  );
}
