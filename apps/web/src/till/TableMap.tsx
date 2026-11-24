import { useEffect, useRef, useState } from "react";
import { formatMoney, type BusinessConfig, type OrderState } from "@pos/core";
import type { FloorSettings } from "../floor";
import { Modal } from "./Modal";
import { courseProgress, isBarTab, isSeatedOrder, mergeProblem, minutesSince, orderBrief, tabLabel, tableInfo, type TableInfo, type TableState } from "./tableOps";
import type { HeldOrder } from "./types";

const LEGEND: Array<[TableState, string]> = [["available", "Available"], ["seated", "Seated"], ["ordered", "Ordered"], ["bill", "Bill asked"], ["overdue", "Overdue"]];

type Pick = null | { kind: "transfer" | "merge"; from: OrderState };

/**
 * The Table Map: the floor (or a list), and the bar tabs. Tap a table to open its bill; press and hold an occupied one for Open order /
 * Transfer / Merge / Fire Course / guest check. Statuses have colours and a legend; every occupied table shows two timers (since seated, since the last order was sent).
 */
export function TableMap(p: {
  floor: FloorSettings; config: BusinessConfig; orders: OrderState[]; held: HeldOrder[]; courses: boolean; canTransfer: boolean;
  onOpen: (name: string) => void; onNewTab: (name: string) => void;
  onTransfer: (o: OrderState, to: string) => Promise<void>; onMerge: (from: OrderState, into: OrderState) => Promise<string | null>;
  onFire: (o: OrderState) => Promise<void>; onBill: (o: OrderState) => Promise<void>; onBack: () => void;
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
          <div className="t-legend" aria-label="Legend">{LEGEND.map(([s, l]) => <span key={s}><i className={`dot s-${s}`} />{l}</span>)}</div>
          <div className="t-floor">
            {p.floor.sections.map((s) => (
              <div key={s.id} className="t-section">
                <h3>{s.name}</h3>
                {layout === "floor" ? (
                  <div className="t-tgrid">{s.tables.filter((t) => !isBarTab(t.name)).map((t) => cell(t.name, t.seats ? `${t.seats} seats` : undefined))}</div>
                ) : (
                  <div className="t-tlist">
                    {s.tables.filter((t) => !isBarTab(t.name)).map((t) => { const i = info(t.name); return (
                      <button key={t.id} className={`t-trow s-${i.state}`} {...press(i)}>
                        <i className={`dot s-${i.state}`} /><strong>{t.name}</strong><span>{LEGEND.find((x) => x[0] === i.state)![1]}</span>
                        <span>{i.state === "available" ? "" : `⏱ ${minutesSince(i.seatedAt, now)}${i.order ? ` · ▶ ${minutesSince(i.lastSentAt, now)}` : ""}`}</span><b>{i.totalCents !== undefined ? formatMoney(i.totalCents) : ""}</b>
                      </button>
                    ); })}
                  </div>
                )}
              </div>
            ))}
          </div>
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
