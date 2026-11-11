import { useEffect, useMemo, useRef, useState } from "react";
import {
  confirmedPaid,
  formatMoney,
  formatQueueNumber,
  newId,
  nextQueueCounter,
  orderTotals,
  splitEqual,
  priceOrder,
  fulfilmentOf,
  menuFor,
  optionLines,
  priceRange,
  resolveOptions,
  type BusinessConfig,
  type ChosenOption,
  type ChosenOptionInput,
  type Catalog,
  type MenuEntry,
  type PaymentMethod,
  type OrderState,
} from "@pos/core";
import { useStaff } from "../auth";
import { deviceId, getDeviceCode, record } from "../db";
import { useOrders } from "../hooks";
import { OptionSheet } from "./OptionSheet";
import { getBalance, spend } from "../wallet";

interface BagLine {
  /** The item and its chosen options: the same item with different options is a different line. */
  key: string;
  item: MenuEntry;
  qty: number;
  selection: ChosenOptionInput[];
  options: ChosenOption[];
  /** One unit, options included. */
  unitCents: number;
}

const TABLES = ["Table 5", "Table 12", "Table 18", "Bar Tab 2", "Bar Tab 4"];
const startOfDay = () => new Date().setHours(0, 0, 0, 0);

interface PosProps {
  config: BusinessConfig;
  catalog: Catalog;
  online: boolean;
  customerId: string;
  setCustomerId: (id: string) => void;
}

export function Pos({ config, catalog, online, customerId, setCustomerId }: PosProps) {
  const orders = useOrders();
  const [bag, setBag] = useState<BagLine[]>([]);
  const [category, setCategory] = useState("All");
  const channels = catalog.channels.filter((c) => c.active);
  const [chosenChannel, setChosenChannel] = useState<string>(channels[0]?.id ?? "");
  // If the chosen channel was removed or switched off while the app was open, use the first one.
  const channel = channels.find((c) => c.id === chosenChannel) ?? channels[0]!;
  const channelId = channel.id;
  const fulfilment = fulfilmentOf(channel.kind);
  const [spot, setSpot] = useState(TABLES[1]!);
  const [flash, setFlash] = useState<string | null>(null);
  const staff = useStaff();
  const [balance, setBalance] = useState<number | null>(null);
  const [paying, setPaying] = useState(false);
  const payLock = useRef(false); // set synchronously, so a fast double-tap cannot start two charges

  useEffect(() => {
    let alive = true;
    if (!customerId || !online || !staff) setBalance(null);
    else void getBalance(customerId).then((b) => alive && setBalance(b));
    return () => {
      alive = false;
    };
  }, [customerId, online, staff]);

  const notify = (text: string) => {
    setFlash(text);
    window.setTimeout(() => setFlash(null), 4000);
  };

  // Prices come from the catalog for this outlet + channel, resolved on the device (works offline).
  const menu = useMemo(() => menuFor(catalog, { outletId: config.outletName, channelId }), [catalog, config.outletName, channelId]);

  // Switching channel (or a price change arriving) reprices the bag; items the channel doesn't sell are dropped.
  useEffect(() => {
    setBag((cur) => {
      const next = cur.flatMap((l) => {
        const e = menu.find((m) => m.id === l.item.id);
        const r = e ? resolveOptions(e.options, l.selection) : null;
        return e && r?.ok ? [{ ...l, item: e, options: r.options, unitCents: e.priceCents + r.extraCents }] : [];
      });
      if (next.length < cur.length) notify(`${cur.length - next.length} item(s) removed: not sold in ${channel.name}.`);
      return next.length === cur.length && next.every((l, i) => l.unitCents === cur[i]!.unitCents && l.item.pricebookId === cur[i]!.item.pricebookId) ? cur : next;
    });
  }, [menu]);

  const categories = useMemo(() => ["All", ...new Set(menu.map((m) => m.category))], [menu]);
  const shown = menu.filter((m) => category === "All" || m.category === category);

  const priced = priceOrder({
    lines: bag.map((b) => ({ name: b.item.name, unitCents: b.unitCents, qty: b.qty, pointsExempt: b.item.pointsExempt })),
    fulfilment,
    serviceCharge: channel.serviceCharge,
    config: config.pricing,
  });

  const [picking, setPicking] = useState<MenuEntry | null>(null);

  /** Put an item in the bag with its chosen options (none for a plain item). */
  const addWith = (item: MenuEntry, selection: ChosenOptionInput[]) => {
    const r = resolveOptions(item.options, selection);
    if (!r.ok) return;
    const key = `${item.id}#${r.key}`;
    setBag((cur) => {
      const found = cur.find((l) => l.key === key);
      return found ? cur.map((l) => (l === found ? { ...l, qty: l.qty + 1 } : l)) : [...cur, { key, item, qty: 1, selection, options: r.options, unitCents: item.priceCents + r.extraCents }];
    });
  };
  // An item with options (hot or cold, extras...) asks first; a plain one goes straight in.
  const add = (item: MenuEntry) => (item.options?.length ? setPicking(item) : addWith(item, []));
  const change = (key: string, d: number) => setBag((cur) => cur.map((l) => (l.key === key ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  /** Create the order in the local log. Nothing here needs the network. */
  async function place(payment: { method: PaymentMethod; confirmed: boolean } | null, existingOrderId?: string) {
    if (!bag.length) return;
    const orderId = existingOrderId ?? newId();
    const code = getDeviceCode();
    const todays = orders.filter((o) => o.openedAt >= startOfDay()).map((o) => o.queueNumber ?? "");
    const queueNumber = config.modules.queue ? formatQueueNumber(code, nextQueueCounter(code, todays)) : undefined;

    await record(orderId, {
      type: "OrderOpened",
      fulfilment,
      channelId,
      channelName: channel.name,
      serviceCharge: channel.serviceCharge,
      spot: channel.kind === "dine_in" ? spot : undefined,
      queueNumber,
    });
    for (const l of bag) {
      await record(orderId, {
        type: "ItemAdded",
        lineId: newId(),
        productId: l.item.id,
        name: l.item.name,
        unitCents: l.unitCents,
        qty: l.qty,
        pointsExempt: l.item.pointsExempt,
        options: l.options.length ? l.options : undefined,
      });
    }
    if (payment) {
      const paymentId = newId();
      await record(orderId, { type: "PaymentRecorded", paymentId, method: payment.method, amountCents: priced.total, confirmed: payment.confirmed });
      if (!payment.confirmed) {
        // MOCK gateway: stands in for the YeahPay callback until real credentials exist.
        window.setTimeout(() => void record(orderId, { type: "PaymentConfirmed", paymentId }), 1500);
      }
    }
    setBag([]);
    notify(queueNumber ? `Order placed · queue number ${queueNumber}` : "Order placed");
  }

  /**
   * Charge prepaid credit first, then record the order. The order id doubles as the idempotency
   * key, so a retry after a dropped connection never charges the customer twice.
   */
  async function payWithCredit() {
    if (!bag.length || !customerId || payLock.current) return;
    payLock.current = true;
    setPaying(true);
    const orderId = newId();
    const r = await spend(customerId, priced.total, `order:${orderId}`, orderId, deviceId());
    payLock.current = false;
    setPaying(false);
    if (r.ok) {
      setBalance(r.balanceCents);
      await place({ method: "credit", confirmed: true }, orderId);
    } else if (r.reason === "insufficient_funds") {
      setBalance(r.balanceCents);
      notify(`Not enough credit: ${formatMoney(r.balanceCents)} available, ${formatMoney(priced.total)} needed.`);
    } else {
      notify(failText(r));
    }
  }

  /** Settle an open tab from credit. The payment id is the idempotency key. */
  async function settleTabWithCredit(o: OrderState, amountCents: number) {
    if (!customerId || payLock.current) return;
    payLock.current = true;
    setPaying(true);
    const paymentId = newId();
    const r = await spend(customerId, amountCents, `tab:${paymentId}`, o.orderId, deviceId());
    payLock.current = false;
    setPaying(false);
    if (r.ok) {
      setBalance(r.balanceCents);
      await record(o.orderId, { type: "PaymentRecorded", paymentId, method: "credit", amountCents, confirmed: true });
    } else if (r.reason === "insufficient_funds") {
      notify(`Not enough credit: ${formatMoney(r.balanceCents)} available.`);
    } else {
      notify(failText(r));
    }
  }

  const creditBlocked = !staff ? "Staff sign-in required" : !customerId ? "Enter a customer to use credit" : !online ? "Credit needs a connection" : "";

  /** Open tab being split: how many people are still to pay, and a custom amount being typed. */
  const [split, setSplit] = useState<{ orderId: string; n: number; custom: string } | null>(null);
  const payShare = async (o: OrderState, cents: number, method: "cash" | "credit") => {
    if (cents <= 0) return;
    if (method === "credit") await settleTabWithCredit(o, cents);
    else await record(o.orderId, { type: "PaymentRecorded", paymentId: newId(), method: "cash", amountCents: cents, confirmed: true });
    setSplit((cur) => (cur && cur.orderId === o.orderId ? { ...cur, n: Math.max(1, cur.n - 1), custom: "" } : cur));
  };

  const openTabs = orders.filter((o) => o.stage !== "cancelled" && o.stage !== "completed" && !isSettled(o, config));
  const prepay = config.paymentTiming === "prepay";

  return (
    <div className="pos">
      <section className="menu">
        <div className="chips">
          {categories.map((c) => (
            <button key={c} className={`chip ${c === category ? "on" : ""}`} onClick={() => setCategory(c)}>
              {c}
            </button>
          ))}
        </div>
        <div className="grid">
          {shown.map((m) => (
            <button key={m.id} className="item" disabled={m.soldOut} onClick={() => add(m)}>
              <span className="n">{m.name}</span>
              <span className="p">{m.soldOut ? "Sold out" : (() => { const [lo, hi] = priceRange(m.priceCents, m.options); return lo === hi ? formatMoney(lo) : `from ${formatMoney(lo)}`; })()}</span>
            </button>
          ))}
        </div>
      </section>

      <aside className="bag">
        {flash && <div className="flash">{flash}</div>}
        <div className="seg">
          {channels.map((c) => (
            <button key={c.id} className={channelId === c.id ? "on" : ""} onClick={() => setChosenChannel(c.id)}>
              {c.name}
            </button>
          ))}
        </div>
        {channel.kind === "dine_in" && (
          <select className="spot" value={spot} onChange={(e) => setSpot(e.target.value)}>
            {TABLES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        )}

        <label className="cust">
          <span>Customer</span>
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value.trim())} placeholder="phone / member code" inputMode="tel" />
          {customerId && <b className="balchip">{balance === null ? "—" : formatMoney(balance)}</b>}
        </label>

        <div className="lines">
          {bag.length === 0 && <p className="muted">Tap items to start an order.</p>}
          {bag.map((l) => (
            <div className="line" key={l.key}>
              <span className="nm">{l.item.name}{l.options.length > 0 && <small className="optline">{optionLines(l.options).join(" · ")}</small>}</span>
              <span className="step">
                <button onClick={() => change(l.key, -1)}>−</button>
                <b>{l.qty}</b>
                <button onClick={() => change(l.key, +1)}>+</button>
              </span>
              <span className="amt">{formatMoney(l.unitCents * l.qty)}</span>
            </div>
          ))}
        </div>

        <dl className="totals">
          <div><dt>Subtotal</dt><dd>{formatMoney(priced.subtotal)}</dd></div>
          {priced.service > 0 && <div><dt>Service charge ({Math.round(config.pricing.serviceRate * 100)}%)</dt><dd>{formatMoney(priced.service)}</dd></div>}
          {priced.gst > 0 && <div><dt>GST</dt><dd>{formatMoney(priced.gst)}</dd></div>}
          {priced.bcrs > 0 && <div><dt>BCRS deposit</dt><dd>{formatMoney(priced.bcrs)}</dd></div>}
          <div className="grand"><dt>Total</dt><dd>{formatMoney(priced.total)}</dd></div>
        </dl>

        {prepay ? (
          <div className="pay">
            <button className="primary" disabled={!bag.length} onClick={() => void place({ method: "cash", confirmed: true })}>
              Cash · {formatMoney(priced.total)}
            </button>
            <button className="primary" disabled={!bag.length || !!creditBlocked || paying} title={creditBlocked} onClick={() => void payWithCredit()}>
              {paying ? "Charging…" : `Pay with credit · ${formatMoney(priced.total)}`}
            </button>
            <button
              className="secondary"
              disabled={!bag.length || !online}
              title={online ? "Mock gateway – confirms after 1.5s" : "Online payments need a connection"}
              onClick={() => void place({ method: "paynow", confirmed: false })}
            >
              PayNow / Card (mock) {online ? "" : "· needs network"}
            </button>
          </div>
        ) : (
          <div className="pay">
            <button className="primary" disabled={!bag.length} onClick={() => void place(null)}>
              {config.paymentTiming === "postpay" ? "Send to kitchen · open tab" : "Place order · pay later"}
            </button>
          </div>
        )}
      </aside>

      {!prepay && openTabs.length > 0 && (
        <section className="tabs">
          <h3>Open tabs</h3>
          {openTabs.map((o) => {
            const t = orderTotals(o, config);
            return (
              <div className="tab" key={o.orderId}>
                <div>
                  <b>{o.spot ?? o.channelName ?? (o.fulfilment === "takeaway" ? "Take away" : "Delivery")}</b>
                  <span className="muted"> · {o.queueNumber ?? "—"} · {o.lines.reduce((n, l) => n + l.qty, 0)} items</span>
                </div>
                <div className="tabr">
                  <span>{formatMoney(t.total - confirmedPaid(o))}</span>
                  <button
                    className="primary sm"
                    onClick={() =>
                      void record(o.orderId, { type: "PaymentRecorded", paymentId: newId(), method: "cash", amountCents: t.total - confirmedPaid(o), confirmed: true })
                    }
                  >
                    Settle cash
                  </button>
                  <button
                    className="secondary sm"
                    disabled={!!creditBlocked || paying}
                    title={creditBlocked}
                    onClick={() => void settleTabWithCredit(o, t.total - confirmedPaid(o))}
                  >
                    Use credit
                  </button>
                  <button className="secondary sm" onClick={() => setSplit(split?.orderId === o.orderId ? null : { orderId: o.orderId, n: 2, custom: "" })}>
                    Split
                  </button>
                </div>
                {split?.orderId === o.orderId && (() => {
                  const remaining = t.total - confirmedPaid(o);
                  const shares = splitEqual(remaining, Array.from({ length: split.n }, (_, i) => `p${i}`), "p0");
                  const next = shares.p0 ?? 0; // the first share carries any extra cents
                  const custom = Math.round(parseFloat(split.custom || "0") * 100);
                  return (
                    <div className="split">
                      <div className="split-row">
                        <span>People still to pay</span>
                        <span className="step">
                          <button aria-label="Fewer people" onClick={() => setSplit({ ...split, n: Math.max(1, split.n - 1) })}>−</button>
                          <b>{split.n}</b>
                          <button aria-label="More people" onClick={() => setSplit({ ...split, n: Math.min(10, split.n + 1) })}>+</button>
                        </span>
                      </div>
                      <div className="split-row">
                        <span>Next share <b>{formatMoney(next)}</b> <small className="muted">of {formatMoney(remaining)} left</small></span>
                        <span>
                          <button className="primary sm" onClick={() => void payShare(o, next, "cash")}>Cash</button>{" "}
                          <button className="secondary sm" disabled={!!creditBlocked || paying} title={creditBlocked} onClick={() => void payShare(o, next, "credit")}>Credit</button>
                        </span>
                      </div>
                      <div className="split-row">
                        <span>Or an amount <input className="split-amt" inputMode="decimal" placeholder="0.00" value={split.custom} onChange={(e) => setSplit({ ...split, custom: e.target.value })} /></span>
                        <span>
                          <button className="primary sm" disabled={!(custom > 0 && custom <= remaining)} onClick={() => void payShare(o, custom, "cash")}>Cash</button>{" "}
                          <button className="secondary sm" disabled={!(custom > 0 && custom <= remaining) || !!creditBlocked || paying} onClick={() => void payShare(o, custom, "credit")}>Credit</button>
                        </span>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </section>
      )}
      {picking && (
        <OptionSheet
          name={picking.name}
          description={picking.description}
          photoUrl={picking.imageVersion ? `/api/products/${picking.id}/image?v=${picking.imageVersion}` : null}
          baseCents={picking.priceCents}
          groups={picking.options!}
          cta="Add to order"
          onClose={() => setPicking(null)}
          onAdd={(sel) => {
            addWith(picking, sel);
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

const failText = (r: { reason: string }) =>
  r.reason === "signin_required"
    ? "Your session has ended. Sign in again. The customer was not charged."
    : r.reason === "not_allowed"
      ? "This account isn't allowed to take credit payments."
      : "Could not reach the server. The customer was not charged.";

function isSettled(o: OrderState, config: BusinessConfig) {
  const total = orderTotals(o, config).total;
  return o.lines.length > 0 && confirmedPaid(o) >= total;
}
