import { useEffect, useMemo, useState } from "react";
import { COURSE_NAMES, kitchenLines, optionLines, visibleToKitchen, type BusinessConfig, type Catalog, type OrderLine, type OrderState } from "@pos/core";
import { currentStaff, staffFetch } from "../auth";
import { record } from "../db";
import { useOrders } from "../hooks";
import { loadTillSettings, useTillSettings } from "../till/tillSettings";

const ago = (ts: number, now: number) => {
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  return m < 1 ? "just now" : `${m} min`;
};
/** A ticket turns amber after this long and red after twice as long. */
const SLOW_MIN = 10;
const LS_STATION = "pos.kdsStation";

/**
 * The kitchen display (handout 4.5). It is the same app as the till, on a device set to open here. It shows only what the kitchen has been
 * given: a held line or a course not yet fired does not appear. A station (hot kitchen, bar...) sees the items of its own categories and
 * presses Done for them; when every item is done the order is ready, and the floor marks it served or collected. A course fired later
 * brings the table back.
 */
export function Kitchen({ config, catalog }: { config: BusinessConfig; catalog?: Catalog }) {
  const orders = useOrders();
  const till = useTillSettings();
  const stations = till.stations ?? [];
  const [now, setNow] = useState(Date.now());
  const [stationId, setStationId] = useState(() => localStorage.getItem(LS_STATION) ?? "");
  const [msg, setMsg] = useState("");
  useEffect(() => { void loadTillSettings(); }, []);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);
  const station = stations.find((s) => s.id === stationId) ?? null;
  const pick = (id: string) => { setStationId(id); try { localStorage.setItem(LS_STATION, id); } catch { /* not kept */ } };
  const categoryOf = useMemo(() => new Map((catalog?.products ?? []).map((p) => [p.id, p.category])), [catalog]);
  /** Does this station make this line? With no station chosen, every line is shown. An item whose category no station has still shows everywhere, so it is never lost. */
  const claimed = useMemo(() => new Set(stations.flatMap((s) => s.categories)), [stations]);
  const mine = (l: OrderLine) => { if (!station) return true; const c = categoryOf.get(l.productId) ?? ""; return station.categories.includes(c) || !claimed.has(c); };
  const who = () => { const s = currentStaff(); return s ? { byName: s.name } : {}; };

  const live = orders.filter((o) => visibleToKitchen(o, config)).map((o) => ({ o, k: kitchenLines(o) }));
  const making = live.filter((x) => x.k.toMake.some(mine)).sort((a, b) => (a.o.lastSentAt ?? a.o.openedAt) - (b.o.lastSentAt ?? b.o.openedAt));
  const waiting = live.filter((x) => x.k.ready.length > 0 && x.k.toMake.length === 0);

  /** A station finishes its items. When that was the last of the order, the order is ready (the queue screen and the customer are told). */
  async function done(o: OrderState, lines: OrderLine[], all: OrderLine[]) {
    await record(o.orderId, { type: "LinesReady", lineIds: lines.map((l) => l.lineId), ...(station ? { station: station.name } : {}), ...who() });
    if (lines.length === all.length && (o.stage === "open" || o.stage === "preparing")) await record(o.orderId, { type: "StageSet", stage: "ready" });
  }
  async function served(o: OrderState, lines: OrderLine[]) {
    await record(o.orderId, { type: "LinesServed", lineIds: lines.map((l) => l.lineId), ...who() });
    // A table that pays later stays open for its next course; an order already paid for is finished once it is handed over.
    if (o.stage === "ready" && (o.fulfilment !== "dine_in" || config.paymentTiming === "prepay")) await record(o.orderId, { type: "StageSet", stage: "completed" });
  }
  async function reprint(o: OrderState) {
    setMsg("");
    const r = await staffFetch("/api/print/reprint", { body: { orderId: o.orderId, docType: "kitchen" } });
    setMsg(!("res" in r) ? r.problem : r.res.ok ? `Kitchen ticket for ${o.queueNumber ?? o.spot ?? "the order"} sent to the printer again.` : r.res.status === 401 || r.res.status === 403 ? "Sign in to print a ticket again." : "The ticket could not be printed again. Check the kitchen printer in Printers.");
  }

  return (
    <div className="kds">
      {stations.length > 0 && (
        <div className="kds-stations" role="tablist" aria-label="Station">
          <button role="tab" aria-selected={!station} className={!station ? "on" : ""} onClick={() => pick("")}>All stations</button>
          {stations.map((s) => <button key={s.id} role="tab" aria-selected={station?.id === s.id} className={station?.id === s.id ? "on" : ""} onClick={() => pick(s.id)}>{s.name}</button>)}
        </div>
      )}
      {config.paymentTiming === "prepay" && <p className="muted note">Fast serve: orders appear here once they are paid.</p>}
      {msg && <p className="flash" role="status">{msg}</p>}
      <h3>To make{station ? ` · ${station.name}` : ""} ({making.length})</h3>
      <div className="tickets">
        {making.length === 0 && <p className="muted">Nothing waiting.</p>}
        {making.map(({ o, k }) => {
          const todo = k.toMake.filter(mine);
          const since = o.lastSentAt ?? o.openedAt;
          const mins = Math.floor((now - since) / 60000);
          return (
            <Ticket key={o.orderId} order={o} since={since} now={now} tone={mins >= SLOW_MIN * 2 ? "late" : mins >= SLOW_MIN ? "slow" : ""} lines={todo} others={station ? k.toMake.length - todo.length : 0} doneCount={k.ready.length + k.served.length}>
              {o.stage === "open" && <button className="secondary" onClick={() => void record(o.orderId, { type: "StageSet", stage: "preparing" })}>Start</button>}
              <button className="primary" onClick={() => void done(o, todo, k.toMake)}>{station ? "Done" : "Ready"}</button>
              <button className="secondary sm" onClick={() => void reprint(o)}>Reprint</button>
            </Ticket>
          );
        })}
      </div>
      <h3>Ready to go out ({waiting.length})</h3>
      <div className="tickets">
        {waiting.map(({ o, k }) => (
          <Ticket key={o.orderId} order={o} since={Math.max(...k.ready.map((l) => l.readyAt ?? 0))} now={now} tone="done" lines={k.ready} others={0} doneCount={0}>
            <button className="secondary" onClick={() => void served(o, k.ready)}>{o.fulfilment === "dine_in" ? "Served" : "Collected"}</button>
          </Ticket>
        ))}
      </div>
    </div>
  );
}

function Ticket({ order, since, now, tone, lines, others, doneCount, children }: { order: OrderState; since: number; now: number; tone: string; lines: OrderLine[]; /** Items other stations still have to make. */ others: number; doneCount: number; children: React.ReactNode }) {
  return (
    <div className={`ticket ${tone} ${order.stage}`}>
      <div className="th">
        <b className="qn">{order.queueNumber ?? order.spot ?? "—"}</b>
        <span>{order.fulfilment === "dine_in" ? (order.spot ?? order.channelName) : (order.channelName ?? (order.fulfilment === "takeaway" ? "Take away" : "Delivery"))}</span>
        <span className="muted kds-timer">{ago(since, now)}</span>
      </div>
      {order.note && <p style={{ margin: "6px 0", fontWeight: 700, color: "#b00020" }}>NOTE: {order.note}</p>}
      <ul>
        {lines.map((l) => (
          <li key={l.lineId}>
            <b>{l.qty}×</b> {l.name}
            {l.course ? <span className={`kds-course c${l.course}`}>{COURSE_NAMES[l.course] ?? `Course ${l.course}`}</span> : null}
            {l.seat ? <span className="kds-seat">Seat {l.seat}</span> : null}
            {l.options?.length ? <small className="optline">{optionLines(l.options).join(" · ")}</small> : null}
          </li>
        ))}
      </ul>
      {(others > 0 || doneCount > 0) && <small className="muted">{[others > 0 ? `${others} more at other stations` : "", doneCount > 0 ? `${doneCount} already done` : ""].filter(Boolean).join(" · ")}</small>}
      <div className="kds-acts">{children}</div>
    </div>
  );
}
