import { applyUpdate, dismissUpdate, useUpdateNotice } from "../pwaUpdate";
import { askConfirm } from "../proto/confirm";
import { mine } from "../shift";

/** A quiet notice at the top of the staff screens: a new version is ready. It never installs by itself. */
export function UpdateBar() {
  const show = useUpdateNotice();
  if (!show) return null;
  const now = async () => {
    let items = 0;
    try { items = (JSON.parse(localStorage.getItem("pos.bag") ?? "null") as { bag?: unknown[] } | null)?.bag?.length ?? 0; } catch { /* nothing on screen */ }
    const warn = [mine() ? "your shift is open" : "", items ? "there are items on the order on screen" : ""].filter(Boolean).join(" and ");
    // Nothing is lost: orders and the open shift are kept on the device. The warning is so no one is surprised by a restart.
    if (warn && !(await askConfirm({ title: "Update Rezein", message: `The till will restart once, and ${warn}. Your data stays on this device. Update now?`, ok: "Update now", cancel: "Later" }))) return;
    applyUpdate();
  };
  return (
    <div className="update-bar" role="status">
      <span>A new version of Rezein POS is ready.</span>
      <button className="primary sm" onClick={now}>Update now</button>
      <button className="secondary sm" onClick={dismissUpdate}>Later</button>
    </div>
  );
}
