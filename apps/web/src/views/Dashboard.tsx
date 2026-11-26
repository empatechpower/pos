import { confirmedPaid, formatMoney, orderTotals, type BusinessConfig } from "@pos/core";
import { go } from "../nav";
import { useStaff } from "../auth";
import { useOrders } from "../hooks";
import { useShift } from "../shift";
import { isTraining } from "../training";
import { openCustomAction, useTillSettings } from "../till/tillSettings";

const startOfDay = () => new Date().setHours(0, 0, 0, 0);

/**
 * The home screen (Q18): today's sales and orders, what is still open, whose shift it is, and big tiles to where people go next.
 * Sign-in lands here unless the shop has turned the Dashboard off.
 */
export function Dashboard({ config }: { config: BusinessConfig }) {
  const staff = useStaff();
  const till = useTillSettings();
  const orders = useOrders();
  const shift = useShift();
  if (!staff) return <div className="credit"><h2>Home</h2><p className="muted">Sign in to see today. <a href="/login">Sign in</a></p></div>;

  const today = startOfDay();
  const real = orders.filter((o) => o.lines.length > 0 && !o.voided && o.stage !== "cancelled" && !o.mergedInto);
  const paidToday = real.filter((o) => (o.paidAt ?? 0) >= today);
  const sales = paidToday.reduce((n, o) => n + confirmedPaid(o), 0);
  const open = real.filter((o) => o.stage !== "completed" && confirmedPaid(o) < orderTotals(o, config).total);
  const tile = (label: string, icon: string, to: string) => <button key={label} className="dashtile" onClick={() => go(to)}><span className="dashicon">{icon}</span>{label}</button>;

  // The markup and class names are the prototype's own (proto-reference/index.html, renderDash), styled by its stylesheet.
  return (
    <div className="proto protohead dashwrap">
      <main className="dashmain">
        <div className="dashstats">
          <div className="dashstat"><small>Today's sales</small><strong>{formatMoney(sales)}</strong></div>
          <div className="dashstat"><small>Orders paid today</small><strong>{paidToday.length}</strong></div>
          <button className="dashstat dashstatbtn" onClick={() => go("/orders?tab=open")}><small>Open orders</small><strong>{open.length}</strong></button>
          <div className="dashstat"><small>Shift</small><strong>{shift ? `Drawer ${shift.drawer} · open` : "—"}</strong></div>
        </div>
        <div className="dashtiles">
          {tile("New Order", "+", "/pos")}
          {tile("Orders", "▤", "/orders")}
          {config.paymentTiming === "postpay" && config.serviceMode !== "retail" && tile("Table Map", "▦", "/pos?view=tables")}
          {tile("Reports", "▥", "/pos?dialog=reports")}
          {tile("Drawer & Shift", "▭", "/pos?dialog=shift")}
          {tile("Settings", "⚙", "/settings")}
          {(till.customActions ?? []).filter((a) => a.where !== "strip").map((a) => <button key={a.id} className="dashtile" style={{ borderColor: a.color }} title="Opens in a new tab" onClick={() => openCustomAction(a)}><span className="dashicon" style={{ color: a.color }}>{a.icon}</span>{a.label}</button>)}
        </div>
        {isTraining() && <p className="trainnote">Training Mode — these figures come from practice data only.</p>}
      </main>
    </div>
  );
}
