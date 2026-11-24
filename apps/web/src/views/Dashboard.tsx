import { confirmedPaid, formatMoney, orderTotals, type BusinessConfig } from "@pos/core";
import { go } from "../nav";
import { useStaff } from "../auth";
import { useOrders } from "../hooks";
import { useShift } from "../shift";
import { isTraining } from "../training";
import { isSeatedOrder } from "../till/tableOps";

const startOfDay = () => new Date().setHours(0, 0, 0, 0);

/**
 * The home screen (Q18): today's sales and orders, what is still open, whose shift it is, and big tiles to where people go next.
 * Sign-in lands here unless the shop has turned the Dashboard off.
 */
export function Dashboard({ config }: { config: BusinessConfig }) {
  const staff = useStaff();
  const orders = useOrders();
  const shift = useShift();
  if (!staff) return <div className="credit"><h2>Home</h2><p className="muted">Sign in to see today. <a href="/login">Sign in</a></p></div>;

  const today = startOfDay();
  const real = orders.filter((o) => o.lines.length > 0 && !o.voided && o.stage !== "cancelled" && !o.mergedInto);
  const paidToday = real.filter((o) => (o.paidAt ?? 0) >= today);
  const sales = paidToday.reduce((n, o) => n + confirmedPaid(o), 0);
  const open = real.filter((o) => o.stage !== "completed" && confirmedPaid(o) < orderTotals(o, config).total);
  const tableService = config.paymentTiming === "postpay";
  const seated = real.filter((o) => isSeatedOrder(o, config));
  const tile = (label: string, icon: string, to: string, note?: string) => <button key={label} className="dash-tile" onClick={() => go(to)}><i>{icon}</i><strong>{label}</strong>{note && <small>{note}</small>}</button>;

  return (
    <div className="dash">
      {isTraining() && <h2>Practice mode</h2>}
      <div className="dash-stats">
        <div><small>Sales today</small><strong>{formatMoney(sales)}</strong></div>
        <div><small>Orders paid today</small><strong>{paidToday.length}</strong></div>
        <button className="dash-open" onClick={() => go("/orders?tab=open")}><small>Open orders</small><strong>{open.length}</strong></button>
        <div><small>Your shift</small><strong>{shift ? `Drawer ${shift.drawer}` : "Not open"}</strong></div>
      </div>
      <div className="dash-tiles">
        {tile("New Order", "＋", "/pos")}
        {tile("Orders", "☰", "/orders", `${open.length} open`)}
        {tableService && tile("Table Map", "▦", "/pos?view=tables", `${seated.length} seated`)}
        {tile("Drawer & Shift", "▭", "/pos?dialog=shift", shift ? `On Drawer ${shift.drawer}` : "Open your shift")}
        {staff.role !== "cashier" && tile("Reports", "▥", "/manager")}
        {tile("Settings", "⚙", "/settings")}
      </div>
    </div>
  );
}
