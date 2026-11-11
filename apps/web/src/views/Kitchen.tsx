import { useEffect, useState } from "react";
import { optionLines, visibleToKitchen, type BusinessConfig, type OrderState } from "@pos/core";
import { record } from "../db";
import { useOrders } from "../hooks";

const ago = (ts: number, now: number) => {
  const m = Math.max(0, Math.floor((now - ts) / 60000));
  return m < 1 ? "just now" : `${m} min`;
};

export function Kitchen({ config }: { config: BusinessConfig }) {
  const orders = useOrders();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, []);

  const live = orders
    .filter((o) => (o.stage === "open" || o.stage === "preparing") && visibleToKitchen(o, config))
    .sort((a, b) => a.openedAt - b.openedAt);
  const ready = orders.filter((o) => o.stage === "ready" && visibleToKitchen(o, config));

  return (
    <div className="kds">
      {config.paymentTiming === "prepay" && (
        <p className="muted note">Fast serve: orders appear here once they are paid.</p>
      )}
      <h3>To make ({live.length})</h3>
      <div className="tickets">
        {live.length === 0 && <p className="muted">Nothing waiting.</p>}
        {live.map((o) => (
          <Ticket key={o.orderId} order={o} now={now}>
            {o.stage === "open" ? (
              <button className="primary" onClick={() => void record(o.orderId, { type: "StageSet", stage: "preparing" })}>Start</button>
            ) : (
              <button className="primary" onClick={() => void record(o.orderId, { type: "StageSet", stage: "ready" })}>Ready</button>
            )}
          </Ticket>
        ))}
      </div>

      <h3>Ready for pickup ({ready.length})</h3>
      <div className="tickets">
        {ready.map((o) => (
          <Ticket key={o.orderId} order={o} now={now} done>
            <button className="secondary" onClick={() => void record(o.orderId, { type: "StageSet", stage: "completed" })}>Collected</button>
          </Ticket>
        ))}
      </div>
    </div>
  );
}

function Ticket({ order, now, done, children }: { order: OrderState; now: number; done?: boolean; children: React.ReactNode }) {
  return (
    <div className={`ticket ${done ? "done" : ""} ${order.stage}`}>
      <div className="th">
        <b className="qn">{order.queueNumber ?? "—"}</b>
        <span>{order.fulfilment === "dine_in" ? (order.spot ?? order.channelName) : (order.channelName ?? (order.fulfilment === "takeaway" ? "Take away" : "Delivery"))}</span>
        <span className="muted">{ago(order.openedAt, now)}</span>
      </div>
      <ul>
        {order.lines.filter((l) => l.qty > 0).map((l) => (
          <li key={l.lineId}>
            <b>{l.qty}×</b> {l.name}
            {l.options?.length ? <small className="optline">{optionLines(l.options).join(" · ")}</small> : null}
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}
