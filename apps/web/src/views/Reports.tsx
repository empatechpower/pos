import { useEffect, useMemo, useState } from "react";
import { confirmedPaid, formatMoney, isFullyPaid, optionLines, orderTotals, type BusinessConfig, type OrderState } from "@pos/core";
import { staffFetch } from "../auth";
import { useOrders } from "../hooks";

const TZ = "Asia/Singapore";
const dayKey = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
const hourOf = (ms: number) => Number(new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: TZ }).slice(0, 2));
const pct = (n: number) => `${n.toFixed(1)}%`;

interface CreditRow { id: string; name: string | null; phone: string | null; openingCents: number; topupsCents: number; spentCents: number; refundsCents: number; adjustmentsCents: number; balanceCents: number }
interface Row { o: OrderState; total: number; subtotal: number; service: number; items: number; member: string }
type Detail = { kind: "order"; id: string } | { kind: "product"; name: string } | { kind: "member"; id: string; name: string };

/**
 * Event and day reports from the order record and the credit ledger: sales over time, products, orders, and
 * member credit, each row opening into its detail. Read-only; nothing here changes an order or a balance.
 */
export function Reports({ config }: { config: BusinessConfig }) {
  const all = useOrders();
  const [credit, setCredit] = useState<CreditRow[] | null>(null);
  const [tab, setTab] = useState<"overview" | "products" | "orders" | "credit">("overview");
  const [stack, setStack] = useState<Detail[]>([]);
  const [day, setDay] = useState<string | "all" | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"qty" | "rev">("qty");

  useEffect(() => {
    void (async () => {
      const r = await staffFetch("/api/reports/credit");
      if ("res" in r && r.res.ok) setCredit(((await r.res.json()) as { members: CreditRow[] }).members);
    })();
  }, []);

  const live = useMemo(() => all.filter((o) => o.lines.some((l) => l.qty > 0) && o.stage !== "cancelled"), [all]);
  const days = useMemo(() => [...new Set(live.map((o) => dayKey(o.openedAt)))].sort(), [live]);
  const chosen = day ?? days[days.length - 1] ?? "all";
  const rows: Row[] = useMemo(
    () =>
      live
        .filter((o) => chosen === "all" || dayKey(o.openedAt) === chosen)
        .map((o) => {
          const t = orderTotals(o, config);
          return { o, total: t.total, subtotal: t.subtotal, service: t.service, items: o.lines.reduce((n, l) => n + Math.max(0, l.qty), 0), member: o.customerName ?? o.customerPhone ?? "Guest" };
        })
        .sort((a, b) => a.o.openedAt - b.o.openedAt),
    [live, chosen, config],
  );

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

  const open = (d: Detail) => setStack((s) => [...s, d]);
  const back = () => setStack((s) => s.slice(0, -1));
  const row = (r: Row) => (
    <button key={r.o.orderId} className="rp-row" onClick={() => open({ kind: "order", id: r.o.orderId })}>
      <span className="rp-main"><b>{timeOf(r.o.openedAt)} · #{r.o.queueNumber ?? "—"} · {r.member}</b><small>{r.o.spot ?? r.o.channelName ?? r.o.fulfilment} · {r.items} item{r.items === 1 ? "" : "s"}</small></span>
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
      const r = rows.find((x) => x.o.orderId === top.id) ?? live.map((o) => ({ o, total: orderTotals(o, config).total, subtotal: orderTotals(o, config).subtotal, service: orderTotals(o, config).service, items: 0, member: o.customerName ?? o.customerPhone ?? "Guest" })).find((x) => x.o.orderId === top.id);
      if (r)
        body = (
          <div className="rp-card">
            <h3>Order #{r.o.queueNumber ?? "—"}</h3>
            <p className="muted">{dayKey(r.o.openedAt)} {timeOf(r.o.openedAt)} · {r.o.spot ?? r.o.channelName ?? r.o.fulfilment} · {r.member}</p>
            <table className="rp-table"><tbody>
              {r.o.lines.filter((l) => l.qty > 0).map((l) => (
                <tr key={l.lineId}><td>{l.qty}× {l.name}{l.options?.length ? <small className="muted" style={{ display: "block" }}>{optionLines(l.options).join(", ")}</small> : null}</td><td className="r">{formatMoney(l.unitCents * l.qty)}</td></tr>
              ))}
              <tr><td>Subtotal</td><td className="r">{formatMoney(r.subtotal)}</td></tr>
              {r.service > 0 && <tr><td>Service charge</td><td className="r">{formatMoney(r.service)}</td></tr>}
              <tr><td><b>Total</b></td><td className="r"><b>{formatMoney(r.total)}</b></td></tr>
            </tbody></table>
            <p className="muted">Paid {formatMoney(confirmedPaid(r.o))}{r.o.payments.filter((p) => p.confirmed).length ? ` by ${[...new Set(r.o.payments.filter((p) => p.confirmed).map((p) => p.method))].join(" + ")}` : ""}</p>
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

  return (
    <div className="rp">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <select value={chosen} onChange={(e) => setDay(e.target.value as string)} aria-label="Which day">
          {days.slice().reverse().map((d) => <option key={d} value={d}>{d}</option>)}
          <option value="all">All days</option>
        </select>
        <span className="muted">{rows.length} order{rows.length === 1 ? "" : "s"}</span>
      </div>
      <div className="rp-kpis">
        <div className="rp-kpi"><small>Sales</small><b>{formatMoney(gross)}</b><span>items {formatMoney(subtotal)} + service {formatMoney(service)}</span></div>
        <div className="rp-kpi"><small>Orders</small><b>{rows.length}</b><span>{itemCount} items · avg {formatMoney(rows.length ? Math.round(gross / rows.length) : 0)}</span></div>
        <div className="rp-kpi"><small>Credit used</small><b>{formatMoney(used)}</b><span>of {formatMoney(issued)} given{issued ? ` · ${pct((used / issued) * 100)}` : ""}</span></div>
        <div className="rp-kpi"><small>Credit left</small><b>{formatMoney(left)}</b><span>{spenders} member{spenders === 1 ? "" : "s"} spent</span></div>
      </div>
      <div className="seg" style={{ margin: "6px 0 10px" }}>
        {(["overview", "products", "orders", "credit"] as const).map((t) => <button key={t} className={tab === t ? "on" : ""} aria-pressed={tab === t} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
      </div>

      {tab === "overview" && (
        <>
          <div className="rp-card"><h3>Sales by hour</h3>
            {byHour.length === 0 ? <p className="muted">No orders in this selection.</p> : byHour.map(([h, v]) => (
              <div className="rp-hbar" key={h}><span>{String(h).padStart(2, "0")}:00</span><span className="rp-track"><i style={{ width: `${(v.cents / maxHour) * 100}%` }} /></span><span>{v.n} · {formatMoney(v.cents)}</span></div>
            ))}
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
          <input className="rp-search" placeholder="Search products…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="seg"><button className={sort === "qty" ? "on" : ""} onClick={() => setSort("qty")}>By quantity</button><button className={sort === "rev" ? "on" : ""} onClick={() => setSort("rev")}>By sales</button></div>
          <div className="rp-card"><h3>{products.length} products</h3>
            {[...products].filter((p) => !needle || p.name.toLowerCase().includes(needle)).sort((a, b) => (sort === "qty" ? b.qty - a.qty || b.cents - a.cents : b.cents - a.cents || b.qty - a.qty)).map(prodRow)}
          </div>
        </>
      )}

      {tab === "orders" && (
        <>
          <input className="rp-search" placeholder="Search by name, number or table…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="rp-card"><h3>Orders</h3>{rows.filter((r) => !needle || `${r.member} ${r.o.queueNumber ?? ""} ${r.o.spot ?? ""}`.toLowerCase().includes(needle)).map(row)}</div>
        </>
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
