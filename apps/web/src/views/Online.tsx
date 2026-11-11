import { useState } from "react";
import { formatMoney, newId, optionLines, orderTotals, confirmedPaid, type BusinessConfig } from "@pos/core";
import { useStaff } from "../auth";
import { record, deviceId } from "../db";
import { useOrders } from "../hooks";
import { spend } from "../wallet";

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

/** Orders customers placed themselves. Accept (or turn down) before the kitchen sees them; settle at the counter. */
export function Online({ config, online }: { config: BusinessConfig; online: boolean }) {
  const staff = useStaff();
  const orders = useOrders().filter((o) => o.source === "online");
  const [msg, setMsg] = useState<string | null>(null);
  const [credit, setCredit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const fresh = orders.filter((o) => !o.acceptedAt && o.stage !== "cancelled").sort((a, b) => a.openedAt - b.openedAt);
  const active = orders.filter((o) => o.acceptedAt && o.stage !== "completed" && o.stage !== "cancelled").sort((a, b) => a.openedAt - b.openedAt);

  async function reject(id: string, q?: string) {
    if (!window.confirm(`Turn down order ${q ?? ""}? The customer will see it as cancelled.`)) return;
    await record(id, { type: "StageSet", stage: "cancelled" });
  }

  async function payCredit(id: string, customer: string, cents: number) {
    if (!customer || busy) return;
    setBusy(id);
    const paymentId = newId();
    const r = await spend(customer, cents, `online:${paymentId}`, id, deviceId());
    setBusy(null);
    if (r.ok) {
      await record(id, { type: "PaymentRecorded", paymentId, method: "credit", amountCents: cents, confirmed: true });
      setMsg(`Paid with credit. Balance ${formatMoney(r.balanceCents)}.`);
    } else if (r.reason === "insufficient_funds") setMsg(`Not enough credit: ${formatMoney(r.balanceCents)} available, ${formatMoney(cents)} needed.`);
    else if (r.reason === "signin_required") setMsg("Sign in as staff to take credit.");
    else setMsg("Could not take credit. The customer was not charged.");
  }

  // A plain function (not a component) so the input inside keeps focus while typing.
  const row = (o: (typeof orders)[number], isNew: boolean) => {
    const t = orderTotals(o, config).total;
    const owing = t - confirmedPaid(o);
    return (
      <div className="tab online" key={o.orderId}>
        <div>
          <b>{o.queueNumber}</b> <span className="muted">· {o.channelName}{o.spot ? ` · ${o.spot}` : ""} · {timeOf(o.openedAt)} · {formatMoney(t)}</span>
          <div>{o.customerName ?? "No name"}{o.customerPhone ? ` · ${o.customerPhone}` : ""}</div>
          <div className="muted">{o.lines.filter((l) => l.qty > 0).map((l) => `${l.qty} × ${l.name}${l.options?.length ? ` (${optionLines(l.options).join(", ")})` : ""}`).join(", ")}</div>
        </div>
        <div className="tabr">
          {isNew ? (
            <>
              <button className="primary sm" onClick={() => void record(o.orderId, { type: "OrderAccepted" })}>Accept</button>
              <button className="secondary sm" onClick={() => void reject(o.orderId, o.queueNumber)}>Turn down</button>
            </>
          ) : owing > 0 ? (
            <>
              <button className="primary sm" onClick={() => void record(o.orderId, { type: "PaymentRecorded", paymentId: newId(), method: "cash", amountCents: owing, confirmed: true })}>Cash {formatMoney(owing)}</button>
              <input className="credit-id" aria-label="Customer for credit" placeholder="customer" value={credit[o.orderId] ?? (o.customerPhone?.replace(/\s|-/g, "") ?? "")} onChange={(e) => setCredit({ ...credit, [o.orderId]: e.target.value.trim() })} />
              <button className="secondary sm" disabled={!staff || !online || busy === o.orderId} title={!staff ? "Staff sign-in required" : !online ? "Credit needs a connection" : ""} onClick={() => void payCredit(o.orderId, credit[o.orderId] ?? o.customerPhone?.replace(/\s|-/g, "") ?? "", owing)}>Use credit</button>
            </>
          ) : (
            <span className="muted">Paid</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="credit prices wide">
      <h2>Online orders</h2>
      {msg && <div className="flash">{msg}</div>}
      <h3>New ({fresh.length})</h3>
      {fresh.length === 0 && <p className="muted">No new orders.</p>}
      {fresh.map((o) => row(o, true))}
      <h3>Accepted ({active.length})</h3>
      {active.length === 0 && <p className="muted">Nothing in progress.</p>}
      {active.map((o) => row(o, false))}
    </div>
  );
}
