import { visibleToKitchen, type BusinessConfig } from "@pos/core";
import { useOrders } from "../hooks";

/** Public display for a TV or tablet: preparing on the left, ready on the right. */
export function Queue({ config }: { config: BusinessConfig | null }) {
  const orders = useOrders();
  const shown = config ? orders.filter((o) => o.queueNumber && visibleToKitchen(o, config)) : [];
  const preparing = shown.filter((o) => o.stage === "open" || o.stage === "preparing").sort((a, b) => a.openedAt - b.openedAt);
  const ready = shown.filter((o) => o.stage === "ready").sort((a, b) => b.openedAt - a.openedAt);

  return (
    <div className="queue">
      <div className="col">
        <h2>Preparing</h2>
        <div className="nums">
          {preparing.map((o) => (
            <span key={o.orderId} className="num">{o.queueNumber}</span>
          ))}
        </div>
      </div>
      <div className="col ready">
        <h2>Ready</h2>
        <div className="nums">
          {ready.map((o) => (
            <span key={o.orderId} className="num">{o.queueNumber}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
