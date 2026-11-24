import { currentStaff, staffFetch } from "./auth";
import { isTraining } from "./training";

/**
 * Every time staff open an order, even only to look, the server is told who and when. If the till has no connection the opening is kept
 * here and sent later with the time it really happened, so nothing is opened silently.
 */
interface Pending { orderId: string; seenIn: string; at: number }
const LS = "pos.viewQueue";
const read = (): Pending[] => { try { return JSON.parse(localStorage.getItem(LS) ?? "[]"); } catch { return []; } };
const write = (q: Pending[]) => localStorage.setItem(LS, JSON.stringify(q.slice(-200)));
let flushing = false;

export async function flushViews(): Promise<void> {
  if (flushing || !currentStaff()) return;
  flushing = true;
  try {
    for (const v of read()) {
      const r = await staffFetch(`/api/orders/${encodeURIComponent(v.orderId)}/viewed`, { method: "POST", body: { seenIn: v.seenIn, at: v.at } });
      // No connection or no sign-in: keep it for later. The server not having the order yet (404) is retried for a day, then dropped.
      if (!("res" in r)) break;
      if (r.res.status === 404 && Date.now() - v.at < 86_400_000) continue;
      write(read().filter((x) => !(x.orderId === v.orderId && x.at === v.at && x.seenIn === v.seenIn)));
    }
  } finally { flushing = false; }
}

/** Record that the signed-in person opened this order. `seenIn` says where ("Online orders", "Reports", "Refund panel"). */
export function logView(orderId: string, seenIn: string): void {
  if (!currentStaff() || isTraining()) return; // practice orders are not real orders
  const q = read();
  const now = Date.now();
  if (q.some((x) => x.orderId === orderId && x.seenIn === seenIn && now - x.at < 10_000)) return;
  write([...q, { orderId, seenIn, at: now }]);
  void flushViews();
}

window.addEventListener("online", () => void flushViews());
setInterval(() => void flushViews(), 30_000);
