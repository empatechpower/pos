import "../proto/proto.css";
import "../proto/extra.css";
import { applyUpdate, dismissUpdate, useUpdateNotice } from "../pwaUpdate";
import { askConfirm } from "../proto/confirm";
import { mine } from "../shift";

/**
 * The update notice, in the prototype's own markup (proto-reference/index.html, showUpdateBar / applyUpdate): a small pill floating at the
 * bottom of the screen, over whatever is showing, so it never covers the header. A new version never installs by itself (decision Q17):
 * it waits here until someone taps Update now, and with a shift open or items on the order it asks first.
 */
export function UpdateBar() {
  const show = useUpdateNotice();
  if (!show) return null;
  const now = async () => {
    let items = 0;
    try { items = (JSON.parse(localStorage.getItem("pos.bag") ?? "null") as { bag?: unknown[] } | null)?.bag?.length ?? 0; } catch { /* nothing on screen */ }
    const why = `${items ? "The current order has items on it. " : ""}${mine() ? "A shift is open. " : ""}`;
    // Nothing is lost: orders and the open shift are kept on the device. The question is so no one is surprised by a restart.
    if (why && !(await askConfirm({ title: "Update Rezein", message: `Updating restarts the app. ${why}Your data is saved on this device and will still be here after the update.`, ok: "Update now", cancel: "Not now" }))) return;
    applyUpdate();
  };
  return (
    <div className="proto protohead">
      <div className="updbar" id="updbar" role="status">
        <span>A new version of Rezein is ready.</span>
        <button className="uapply" onClick={() => void now()}>Update now</button>
        <button onClick={dismissUpdate}>Later</button>
      </div>
    </div>
  );
}
