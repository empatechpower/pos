import { useEffect, useMemo, useState } from "react";
import { confirmedPaid, formatMoney, hourly, isFullyPaid, optionLines, orderTotals, productMix, reportWeekday, staffSales, summarize, type BusinessConfig, type Catalog, type OrderState, paymentKey, paymentLabel } from "@pos/core";
import { staffFetch } from "../auth";
import { logView } from "../orderViews";
import { useOrders } from "../hooks";
import { downloadText, money, toCsv } from "../csv";

const TZ = "Asia/Singapore";
const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const hourOf = (ms: number) => Number(new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }).slice(0, 2));
const METHOD: Record<string, string> = { cash: "Cash", card: "Card", paynow: "PayNow", credit: "Credit" };
const methodName = (m: string) => METHOD[m] ?? paymentLabel(m);
const pct = (n: number) => `${n.toFixed(1)}%`;

interface CreditRow { id: string; name: string | null; phone: string | null; openingCents: number; topupsCents: number; spentCents: number; refundsCents: number; adjustmentsCents: number; balanceCents: number }
interface Row { o: OrderState; total: number; subtotal: number; service: number; items: number; member: string }
type Detail = { kind: "order"; id: string } | { kind: "product"; name: string } | { kind: "member"; id: string; name: string };

/**
 * Event and day reports from the order record and the credit ledger: sales over time, products, orders, and
 * member credit, each row opening into its detail. Read-only; nothing here changes an order or a balance.
 */
export function Reports({ config, catalog }: { config: BusinessConfig; catalog?: Catalog | null }) {
  const all = useOrders();
  const [credit, setCredit] = useState<CreditRow[] | null>(null);
  const [tab, setTab] = useState<"overview" | "products" | "orders" | "staff" | "credit">("overview");
  const [from, setFrom] = useState(() => dayKey(Date.now()));
  const [to, setTo] = useState(() => dayKey(Date.now()));
  /** Who owned each shift, for payments taken before payments carried a name. */
  const [shiftNames, setShiftNames] = useState<Map<string, string>>(new Map());
  const [stack, setStack] = useState<Detail[]>([]);
  const [day, setDay] = useState<string | "all" | "last24" | null>(null);
  const [mixCat, setMixCat] = useState("");
  const [mixChannel, setMixChannel] = useState("");
  const [mixDay, setMixDay] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"qty" | "rev">("qty");

  useEffect(() => {
    void (async () => {
      const r = await staffFetch("/api/reports/credit");
      if ("res" in r && r.res.ok) setCredit(((await r.res.json()) as { members: CreditRow[] }).members);
      const sh = await staffFetch("/api/shifts");
      if ("res" in sh && sh.res.ok) setShiftNames(new Map(((await sh.res.json()) as { shifts: Array<{ id: string; staffName: string }> }).shifts.map((s) => [s.id, s.staffName])));
    })();
  }, []);

  const live = useMemo(() => all.filter((o) => o.lines.some((l) => l.qty > 0) && o.stage !== "cancelled"), [all]);
  const days = useMemo(() => [...new Set(live.map((o) => dayKey(o.openedAt)))].sort(), [live]);
  const chosen = day ?? days[days.length - 1] ?? "all";
  // Which orders the screen covers: one day, the last 24 hours, every day, or a range of dates (from and to are both included).
  const inChosen = (o: OrderState) => (chosen === "all" ? true : chosen === "last24" ? o.openedAt >= Date.now() - 24 * 3600_000 : chosen === "range" ? dayKey(o.openedAt) >= (from <= to ? from : to) && dayKey(o.openedAt) <= (from <= to ? to : from) : dayKey(o.openedAt) === chosen);
  const rows: Row[] = useMemo(
    () =>
      live
        .filter((o) => inChosen(o))
        .map((o) => {
          const t = orderTotals(o, config);
          return { o, total: t.total, subtotal: t.subtotal, service: t.service, items: o.lines.reduce((n, l) => n + Math.max(0, l.qty), 0), member: o.customerName ?? o.customerPhone ?? "Guest" };
        })
        .sort((a, b) => a.o.openedAt - b.o.openedAt),
    [live, chosen, from, to, config],
  );

  const rangeOrders = useMemo(() => all.filter((o) => o.lines.some((l) => l.qty > 0) && inChosen(o)), [all, chosen, from, to]); // eslint-disable-line react-hooks/exhaustive-deps
  const staffRows = useMemo(() => staffSales(rangeOrders, config, (id) => shiftNames.get(id)), [rangeOrders, config, shiftNames]);
  const summary = useMemo(() => summarize(rangeOrders, config), [rangeOrders, config]);
  const hours = useMemo(() => hourly(rangeOrders, config), [rangeOrders, config]);
  const categoryOf = useMemo(() => { const m = new Map((catalog?.products ?? []).map((p) => [p.id, p.category])); return (id: string) => m.get(id) ?? ""; }, [catalog]);
  const mix = useMemo(() => productMix(rangeOrders, categoryOf, { category: mixCat || undefined, channel: mixChannel || undefined, weekday: mixDay === "" ? undefined : Number(mixDay) }), [rangeOrders, categoryOf, mixCat, mixChannel, mixDay]);
  const mixCats = useMemo(() => [...new Set(productMix(rangeOrders, categoryOf).map((x) => x.category))].sort(), [rangeOrders, categoryOf]);
  const mixChannels = useMemo(() => [...new Set(rangeOrders.map((o) => o.channelName ?? o.fulfilment))].sort(), [rangeOrders]);
  const gross = rows.reduce((n, r) => n + r.total, 0);
  const subtotal = rows.reduce((n, r) => n + r.subtotal, 0);
  const service = rows.reduce((n, r) => n + r.service, 0);
  const itemCount = rows.reduce((n, r) => n + r.items, 0);
  const unpaid = rows.filter((r) => !isFullyPaid(r.o, config));

  const products = useMemo(() => {
    const m = new Map<string, { name: string; qty: number; cents: number; orders: Array<{ id: string; qty: number; cents: number }> }>();
    for (const r of rows)
      for (const l of r.o.lines) {
        if (l.qty <= 0) continue;
        const p = m.get(l.name) ?? { name: l.name, qty: 0, cents: 0, orders: [] };
        const cents = l.unitCents * l.qty;
        p.qty += l.qty;
        p.cents += cents;
        const prev = p.orders.find((x) => x.id === r.o.orderId);
        if (prev) { prev.qty += l.qty; prev.cents += cents; } else p.orders.push({ id: r.o.orderId, qty: l.qty, cents });
        m.set(l.name, p);
      }
    return [...m.values()];
  }, [rows]);

  const byHour = useMemo(() => {
    const m = new Map<number, { n: number; cents: number }>();
    for (const r of rows) { const h = hourOf(r.o.openedAt); const x = m.get(h) ?? { n: 0, cents: 0 }; x.n++; x.cents += r.total; m.set(h, x); }
    return [...m].sort((a, b) => a[0] - b[0]);
  }, [rows]);

  const pool = credit ?? [];
  const issued = pool.reduce((n, m) => n + m.openingCents + m.topupsCents, 0);
  const used = pool.reduce((n, m) => n + m.spentCents - m.refundsCents, 0);
  const left = pool.reduce((n, m) => n + m.balanceCents, 0);
  const spenders = pool.filter((m) => m.spentCents > 0).length;
  const extra = pool.filter((m) => m.topupsCents !== 0 || m.adjustmentsCents !== 0);

  const open = (d: Detail) => { if (d.kind === "order") logView(d.id, "Reports"); setStack((s) => [...s, d]); };
  const back = () => setStack((s) => s.slice(0, -1));
  const row = (r: Row) => (
    <button key={r.o.orderId} className="rp-row" onClick={() => open({ kind: "order", id: r.o.orderId })}>
      <span className="rp-main"><b>{timeOf(r.o.openedAt)} · #{r.o.queueNumber ?? "—"} · {r.member}</b><small>{r.o.spot ?? r.o.channelName ?? r.o.fulfilment} · {r.items} item{r.items === 1 ? "" : "s"} · {r.o.stage === "cancelled" ? "Cancelled" : isFullyPaid(r.o, config) ? "Paid" : "Unpaid"}</small></span>
      <span className="rp-amt">{formatMoney(r.total)}</span><span className="rp-chev">›</span>
    </button>
  );
  const prodRow = (p: { name: string; qty: number; cents: number }) => (
    <button key={p.name} className="rp-row" onClick={() => open({ kind: "product", name: p.name })}>
      <span className="rp-main"><b>{p.name}</b><small>{p.qty} sold</small></span><span className="rp-amt">{formatMoney(p.cents)}</span><span className="rp-chev">›</span>
    </button>
  );
  const memberRow = (m: CreditRow) => {
    const usedC = m.spentCents - m.refundsCents;
    const given = m.openingCents + m.topupsCents;
    const p = given > 0 ? Math.min(100, (usedC / given) * 100) : 0;
    return (
      <button key={m.id} className="rp-row" onClick={() => open({ kind: "member", id: m.id, name: m.name ?? m.phone ?? "Member" })}>
        <span className="rp-main"><b>{m.name ?? m.phone ?? "(no name)"}{m.topupsCents !== 0 ? " ⚑" : ""}</b><small>used {formatMoney(usedC)} of {formatMoney(given)} · {pct(p)}</small><span className="rp-bar"><i style={{ width: `${p}%` }} /></span></span>
        <span className="rp-amt">{formatMoney(m.balanceCents)} left</span><span className="rp-chev">›</span>
      </button>
    );
  };

  // ---- a detail view on top of the tabs ----
  const top = stack[stack.length - 1];
  if (top) {
    let body: JSX.Element | null = null;
    if (top.kind === "order") {
      const r = rows.find((x) => x.o.orderId === top.id) ?? all.filter((o) => o.lines.some((l) => l.qty > 0)).map((o) => ({ o, total: orderTotals(o, config).total, subtotal: orderTotals(o, config).subtotal, service: orderTotals(o, config).service, items: 0, member: o.customerName ?? o.customerPhone ?? "Guest" })).find((x) => x.o.orderId === top.id);
      if (r)
        body = (
          <div className="rp-card">
            <h3>Order #{r.o.queueNumber ?? "—"}</h3>
            <p className="muted">Opened {dayKey(r.o.openedAt)} {timeOf(r.o.openedAt)}{r.o.closedAt ? ` · ${r.o.stage === "cancelled" ? "cancelled" : "closed"} ${timeOf(r.o.closedAt)}` : ""} · {r.o.spot ?? r.o.channelName ?? r.o.fulfilment} · {r.member}{r.o.source === "online" ? " · online" : ""}</p>
            <table className="rp-table"><tbody>
              {r.o.lines.filter((l) => l.qty > 0).map((l) => (
                <tr key={l.lineId}><td>{l.qty}× {l.name}{l.options?.length ? <small className="muted" style={{ display: "block" }}>{optionLines(l.options).join(", ")}</small> : null}</td><td className="r">{formatMoney(l.unitCents * l.qty)}</td></tr>
              ))}
              <tr><td>Subtotal</td><td className="r">{formatMoney(r.subtotal)}</td></tr>
              {(() => { const t = orderTotals(r.o, config); return (<>
                {t.couponDiscount > 0 && <tr><td>Coupon{r.o.coupon ? ` · ${r.o.coupon.title}` : ""}</td><td className="r">−{formatMoney(t.couponDiscount)}</td></tr>}
                {t.discountCents > 0 && <tr><td>Discount{(r.o.discounts ?? []).length ? ` · ${(r.o.discounts ?? []).map((x) => x.reason).join(", ")}` : ""}</td><td className="r">−{formatMoney(t.discountCents)}</td></tr>}
                {t.pointsDiscount > 0 && <tr><td>Points ({t.pointsUsed})</td><td className="r">−{formatMoney(t.pointsDiscount)}</td></tr>}
                {t.service > 0 && <tr><td>Service charge</td><td className="r">{formatMoney(t.service)}</td></tr>}
                {t.gst > 0 && <tr><td>GST</td><td className="r">{formatMoney(t.gst)}</td></tr>}
                {t.bcrs > 0 && <tr><td>BCRS deposit</td><td className="r">{formatMoney(t.bcrs)}</td></tr>}
              </>); })()}
              <tr><td><b>Total</b></td><td className="r"><b>{formatMoney(r.total)}</b></td></tr>
            </tbody></table>
            <p className="muted">Paid {formatMoney(confirmedPaid(r.o))}{r.o.payments.filter((p) => p.confirmed).length ? ` · ${r.o.payments.filter((p) => p.confirmed).map((p) => `${methodName(paymentKey(p))} ${formatMoney(p.amountCents)}`).join(" + ")}` : ""}</p>
          </div>
        );
    } else if (top.kind === "product") {
      const p = products.find((x) => x.name === top.name);
      if (p)
        body = (
          <>
            <div className="rp-card"><h3>{p.name}</h3><p className="muted">{p.qty} sold · {formatMoney(p.cents)} · {subtotal ? pct((p.cents / subtotal) * 100) : "—"} of item sales</p></div>
            <div className="rp-card"><h3>Orders with this product</h3>{p.orders.map((x) => { const r = rows.find((y) => y.o.orderId === x.id); return r ? row(r) : null; })}</div>
          </>
        );
    } else {
      const m = pool.find((x) => x.id === top.id);
      const mine = rows.filter((r) => r.o.memberId === top.id);
      body = (
        <>
          <div className="rp-card">
            <h3>{top.name}</h3>
            {m && (
              <div className="rp-kv">
                <div><small>Opening credit</small><b>{formatMoney(m.openingCents)}</b></div>
                <div><small>Added later</small><b>{formatMoney(m.topupsCents + m.adjustmentsCents)}</b></div>
                <div><small>Spent</small><b>{formatMoney(m.spentCents - m.refundsCents)}</b></div>
                <div><small>Balance now</small><b>{formatMoney(m.balanceCents)}</b></div>
              </div>
            )}
            {m && m.topupsCents !== 0 && <p className="rp-flag">Credit was added after the opening load: {formatMoney(m.topupsCents)}. See Credit history under Manager → Members for who added it and when.</p>}
          </div>
          <div className="rp-card"><h3>Orders ({mine.length})</h3>{mine.length ? mine.map(row) : <p className="muted">No orders in this selection.</p>}</div>
        </>
      );
    }
    return (
      <div className="rp">
        <button className="secondary sm" onClick={back}>‹ Back</button>
        {body ?? <p className="muted">Nothing to show.</p>}
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const maxHour = Math.max(1, ...byHour.map((h) => h[1].cents));
  const topProducts = [...products].sort((a, b) => b.qty - a.qty || b.cents - a.cents);
  const spendersList = [...pool].filter((m) => m.spentCents > 0).sort((a, b) => b.spentCents - a.spentCents);

  /** The tab on screen as a CSV file, named for what it is and the dates it covers. */
  function exportCsv() {
    const label = chosen === "range" ? `${from <= to ? from : to}_to_${from <= to ? to : from}` : chosen;
    let rowsOut: Array<Array<string | number>> = [];
    if (tab === "staff") {
      rowsOut = [["Staff", "Taken (S$)", "Orders", "Average order (S$)", "Cash (S$)", "PayNow (S$)", "Card (S$)", "Credit (S$)", "Refunds approved", "Refunded (S$)", "Discounts given", "Discounted (S$)", "Orders voided", "Voided (S$)", "Net (S$)"],
        ...staffRows.map((r) => [r.name, money(r.takenCents), r.orders, money(r.averageCents), money(r.byMethod.cash ?? 0), money(r.byMethod.paynow ?? 0), money(r.byMethod.card ?? 0), money(r.byMethod.credit ?? 0), r.refunds, money(r.refundedCents), r.discounts, money(r.discountCents), r.voids, money(r.voidedCents), money(r.netCents)])];
    } else if (tab === "products") {
      rowsOut = [["Item", "Category", "Quantity", "Sales (S$)", "Average (S$)", "Share of sales (%)"], ...mix.map((m) => [m.name, m.category, m.qty, money(m.cents), money(m.averageCents), (m.share * 100).toFixed(1)])];
    } else if (tab === "orders") {
      rowsOut = [["Date", "Time", "Order", "Where", "Customer", "Items", "Total (S$)", "Status"], ...rows.map((r) => [dayKey(r.o.openedAt), timeOf(r.o.openedAt), r.o.queueNumber ?? "", r.o.spot ?? r.o.channelName ?? r.o.fulfilment, r.member, r.items, money(r.total), r.o.voided ? "Voided" : isFullyPaid(r.o, config) ? "Paid" : "Open"])];
    } else if (tab === "credit") {
      rowsOut = [["Member", "Phone", "Given (S$)", "Used (S$)", "Left (S$)"], ...pool.map((m) => [m.name ?? "", m.phone ?? "", money(m.openingCents + m.topupsCents), money(m.spentCents - m.refundsCents), money(m.balanceCents)])];
    } else {
      const days = new Map<string, { n: number; items: number; cents: number }>();
      for (const r of rows) { const d = dayKey(r.o.openedAt); const x = days.get(d) ?? { n: 0, items: 0, cents: 0 }; x.n++; x.items += r.items; x.cents += r.total; days.set(d, x); }
      rowsOut = [["Date", "Orders", "Items", "Sales (S$)", "Average order (S$)"], ...[...days].sort().map(([d, x]) => [d, x.n, x.items, money(x.cents), money(x.n ? Math.round(x.cents / x.n) : 0)])];
    }
    downloadText(`${tab}_${label}.csv`, toCsv(rowsOut));
  }

  return (
    <div className="rp">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <select value={chosen} onChange={(e) => setDay(e.target.value as string)} aria-label="Which day">
          {days.slice().reverse().map((d) => <option key={d} value={d}>{d}</option>)}
          <option value="last24">Last 24 hours</option>
          <option value="range">A range of dates…</option>
          <option value="all">All days</option>
        </select>
        {chosen === "range" && (
          <>
            <label className="muted">From <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From date" /></label>
            <label className="muted">To <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="To date" /></label>
          </>
        )}
        <span className="muted">{rows.length} order{rows.length === 1 ? "" : "s"}</span>
        <span className="rp-actions" style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button className="secondary sm" onClick={exportCsv}>Export CSV</button>
          <button className="secondary sm" onClick={() => window.print()} title="Opens the print window: choose a printer, or Save as PDF">Print / Save as PDF</button>
        </span>
      </div>
      <h2 className="rp-printtitle">{tab[0]!.toUpperCase() + tab.slice(1)} report · {chosen === "range" ? `${from <= to ? from : to} to ${from <= to ? to : from}` : chosen === "all" ? "All days" : chosen === "last24" ? "Last 24 hours" : chosen} · {config.name}</h2>
      <div className="rp-kpis">
        <div className="rp-kpi"><small>Sales</small><b>{formatMoney(gross)}</b><span>items {formatMoney(subtotal)} + service {formatMoney(service)}</span></div>
        <div className="rp-kpi"><small>Orders</small><b>{rows.length}</b><span>{itemCount} items · avg {formatMoney(rows.length ? Math.round(gross / rows.length) : 0)}</span></div>
        <div className="rp-kpi"><small>Credit used</small><b>{formatMoney(used)}</b><span>of {formatMoney(issued)} given{issued ? ` · ${pct((used / issued) * 100)}` : ""}</span></div>
        <div className="rp-kpi"><small>Credit left</small><b>{formatMoney(left)}</b><span>{spenders} member{spenders === 1 ? "" : "s"} spent</span></div>
      </div>
      <div className="seg" style={{ margin: "6px 0 10px" }}>
        {(["overview", "products", "orders", "staff", "credit"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} aria-pressed={tab === t} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
      </div>

      {tab === "overview" && (
        <>
          <div className="rp-card"><h3>Sales summary</h3>
            <table className="rp-table"><tbody>
              <tr><td>Gross sales (items)</td><td className="r">{formatMoney(summary.grossCents)}</td></tr>
              <tr><td>Discounts{summary.discountsCents ? <small className="muted" style={{ display: "block" }}>coupons {formatMoney(summary.couponCents)} · points {formatMoney(summary.pointsCents)}</small> : null}</td><td className="r">−{formatMoney(summary.discountsCents)}</td></tr>
              <tr><td><b>Net sales</b></td><td className="r"><b>{formatMoney(summary.netCents)}</b></td></tr>
              <tr><td>Service charge</td><td className="r">{formatMoney(summary.serviceCents)}</td></tr>
              <tr><td>GST</td><td className="r">{formatMoney(summary.gstCents)}</td></tr>
              <tr><td>Container deposits<small className="muted" style={{ display: "block" }}>held for the customer, not sales</small></td><td className="r">{formatMoney(summary.liabilitiesCents)}</td></tr>
              <tr><td><b>Net to account for</b></td><td className="r"><b>{formatMoney(summary.netToAccountForCents)}</b></td></tr>
            </tbody></table>
            <h4 style={{ margin: "10px 0 2px" }}>Payments</h4>
            <table className="rp-table"><tbody>
              {summary.payments.length === 0 && <tr><td className="muted">No payments yet.</td><td /></tr>}
              {summary.payments.map((p) => <tr key={p.method}><td>{methodName(p.method)} <small className="muted">· {p.count}</small></td><td className="r">{formatMoney(p.cents)}</td></tr>)}
              {summary.unpaidOrders > 0 && <tr><td className="muted">Not fully paid</td><td className="r">{summary.unpaidOrders} order{summary.unpaidOrders === 1 ? "" : "s"}</td></tr>}
              {summary.voided.orders > 0 && <tr><td>Voided (cancelled)</td><td className="r">{summary.voided.orders} · {formatMoney(summary.voided.cents)}</td></tr>}
            </tbody></table>
            <p className="muted">Net to account for = net sales + service + GST + deposits, and equals what customers were billed.</p>
          </div>
          <div className="rp-card"><h3>Hourly sales</h3>
            {hours.length === 0 ? <p className="muted">No orders in this selection.</p> : (
              <table className="rp-table"><thead><tr><th align="left">Hour</th><th align="right">Orders</th><th align="right">Items</th><th align="right">Avg</th><th align="right">Total</th></tr></thead><tbody>
                {hours.map((h) => (
                  <tr key={h.hour}><td>{String(h.hour).padStart(2, "0")}:00<span className="rp-track" style={{ display: "block", height: 6, marginTop: 3 }}><i style={{ width: `${(h.cents / Math.max(1, ...hours.map((x) => x.cents))) * 100}%` }} /></span></td><td className="r">{h.orders}</td><td className="r">{h.items}</td><td className="r">{formatMoney(h.averageCents)}</td><td className="r">{formatMoney(h.cents)}</td></tr>
                ))}
              </tbody></table>
            )}
          </div>
          <div className="rp-card"><h3>Top products</h3>{topProducts.slice(0, 10).map(prodRow)}</div>
          <div className="rp-card"><h3>Top spenders</h3>{spendersList.slice(0, 8).map(memberRow)}</div>
          <div className="rp-card"><h3>Worth a look</h3>
            {unpaid.length > 0 && <p className="rp-flag">{unpaid.length} order{unpaid.length === 1 ? " is" : "s are"} not fully paid.</p>}
            {extra.length > 0 && <p className="rp-flag">{extra.length} member{extra.length === 1 ? " was" : "s were"} given credit after the opening load: {extra.map((m) => `${m.name ?? m.phone} ${formatMoney(m.topupsCents + m.adjustmentsCents)}`).join(", ")}.</p>}
            {unpaid.length === 0 && extra.length === 0 && <p className="muted">Nothing to flag.</p>}
          </div>
        </>
      )}

      {tab === "products" && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <select value={mixCat} onChange={(e) => setMixCat(e.target.value)} aria-label="Category"><option value="">All categories</option>{mixCats.map((c) => <option key={c}>{c}</option>)}</select>
            <select value={mixChannel} onChange={(e) => setMixChannel(e.target.value)} aria-label="Order type"><option value="">All order types</option>{mixChannels.map((c) => <option key={c}>{c}</option>)}</select>
            <select value={mixDay} onChange={(e) => setMixDay(e.target.value)} aria-label="Day of week"><option value="">Every weekday</option>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
          </div>
          <input className="rp-search" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="seg"><button className={sort === "qty" ? "on" : ""} onClick={() => setSort("qty")}>By quantity</button><button className={sort === "rev" ? "on" : ""} onClick={() => setSort("rev")}>By sales</button></div>
          {(() => {
            const ranked = [...mix].sort((a, b) => (sort === "qty" ? b.qty - a.qty || b.cents - a.cents : b.cents - a.cents || b.qty - a.qty));
            const top = ranked.slice(0, 10);
            const biggest = Math.max(1, ...top.map((x) => (sort === "qty" ? x.qty : x.cents)));
            return (
              <>
                <div className="rp-card"><h3>Top {top.length || 10}</h3>
                  {top.length === 0 ? <p className="muted">Nothing sold in this selection.</p> : top.map((x) => (
                    <div className="rp-hbar" key={x.name}><span style={{ width: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.name}</span><span className="rp-track"><i style={{ width: `${((sort === "qty" ? x.qty : x.cents) / biggest) * 100}%` }} /></span><span style={{ minWidth: 80 }}>{sort === "qty" ? `${x.qty} sold` : formatMoney(x.cents)}</span></div>
                  ))}
                </div>
                <div className="rp-card"><h3>{ranked.length} products</h3>
                  {ranked.filter((p) => !needle || p.name.toLowerCase().includes(needle)).map((p) => (
                    <button key={p.name} className="rp-row" onClick={() => open({ kind: "product", name: p.name })}>
                      <span className="rp-main"><b>{p.name}</b><small>{p.category} · {p.qty} sold · avg {formatMoney(p.averageCents)} · {pct(p.share * 100)}</small></span><span className="rp-amt">{formatMoney(p.cents)}</span><span className="rp-chev">›</span>
                    </button>
                  ))}
                </div>
              </>
            );
          })()}
        </>
      )}

      {tab === "orders" && (
        <>
          <input className="rp-search" placeholder="Search by name, number or table…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="inline" style={{ display: "block", margin: "6px 0" }}><input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} /> Show cancelled orders</label>
          <div className="rp-card"><h3>Orders</h3>{(showCancelled ? rangeOrders.map((o) => ({ o, total: orderTotals(o, config).total, subtotal: orderTotals(o, config).subtotal, service: orderTotals(o, config).service, items: o.lines.reduce((n, l) => n + Math.max(0, l.qty), 0), member: o.customerName ?? o.customerPhone ?? "Guest" })).sort((a, b) => a.o.openedAt - b.o.openedAt) : rows).filter((r) => !needle || `${r.member} ${r.o.queueNumber ?? ""} ${r.o.spot ?? ""}`.toLowerCase().includes(needle)).map(row)}</div>
        </>
      )}

      {tab === "staff" && (
        <div className="rp-card"><h3>Sales by person</h3>
          <p className="muted">Payments belong to whoever took them. Refunds and voids belong to the manager who approved them; discounts to whoever gave them. “Not recorded” is money taken before payments carried a name.</p>
          {staffRows.length === 0 && <p className="muted">No sales in this period.</p>}
          {staffRows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="rp-table" aria-label="Sales by person"><thead><tr><th>Person</th><th className="r">Taken</th><th className="r">Orders</th><th className="r">Average</th><th className="r">Cash</th><th className="r">PayNow</th><th className="r">Card</th><th className="r">Credit</th><th className="r">Refunds</th><th className="r">Discounts</th><th className="r">Voids</th><th className="r">Net</th></tr></thead>
                <tbody>
                  {staffRows.map((r) => <tr key={r.name}><td>{r.name}</td><td className="r">{formatMoney(r.takenCents)}</td><td className="r">{r.orders}</td><td className="r">{formatMoney(r.averageCents)}</td><td className="r">{formatMoney(r.byMethod.cash ?? 0)}</td><td className="r">{formatMoney(r.byMethod.paynow ?? 0)}</td><td className="r">{formatMoney(r.byMethod.card ?? 0)}</td><td className="r">{formatMoney(r.byMethod.credit ?? 0)}</td><td className="r">{r.refunds ? `${r.refunds} · ${formatMoney(r.refundedCents)}` : "—"}</td><td className="r">{r.discounts ? `${r.discounts} · ${formatMoney(r.discountCents)}` : "—"}</td><td className="r">{r.voids ? `${r.voids} · ${formatMoney(r.voidedCents)}` : "—"}</td><td className="r"><b>{formatMoney(r.netCents)}</b></td></tr>)}
                  <tr><td><b>Total</b></td><td className="r"><b>{formatMoney(staffRows.reduce((n, r) => n + r.takenCents, 0))}</b></td><td className="r">{staffRows.reduce((n, r) => n + r.orders, 0)}</td><td /><td className="r">{formatMoney(staffRows.reduce((n, r) => n + (r.byMethod.cash ?? 0), 0))}</td><td className="r">{formatMoney(staffRows.reduce((n, r) => n + (r.byMethod.paynow ?? 0), 0))}</td><td className="r">{formatMoney(staffRows.reduce((n, r) => n + (r.byMethod.card ?? 0), 0))}</td><td className="r">{formatMoney(staffRows.reduce((n, r) => n + (r.byMethod.credit ?? 0), 0))}</td><td /><td /><td /><td className="r"><b>{formatMoney(staffRows.reduce((n, r) => n + r.netCents, 0))}</b></td></tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {tab === "credit" && (
        <>
          {credit === null ? <p className="muted">Loading credit…</p> : (
            <>
              <div className="rp-card"><h3>Credit pool</h3>
                <div className="rp-kv">
                  <div><small>Given</small><b>{formatMoney(issued)}</b></div>
                  <div><small>Used</small><b>{formatMoney(used)}</b></div>
                  <div><small>Left</small><b>{formatMoney(left)}</b></div>
                  <div><small>Used %</small><b>{issued ? pct((used / issued) * 100) : "—"}</b></div>
                </div>
                <p className="muted">Given = opening credit plus anything added later. Used is net of refunds. These come from the credit ledger, so they always match each member's balance.</p>
              </div>
              <input className="rp-search" placeholder="Search members…" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="rp-card">{[...pool].filter((m) => !needle || `${m.name ?? ""} ${m.phone ?? ""}`.toLowerCase().includes(needle)).sort((a, b) => b.spentCents - a.spentCents).map(memberRow)}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
