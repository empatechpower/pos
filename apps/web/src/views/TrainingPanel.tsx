import { useShift } from "../shift";
import { askConfirm } from "../proto/confirm";
import { isTraining, resetPracticeData, setTraining } from "../training";

/** For managers: put this till into practice mode so a new person can learn on it without touching real orders, payments or printers. */
export function TrainingPanel() {
  const shift = useShift();
  const on = isTraining();
  return (
    <div style={{ marginTop: 24 }}>
      <h3>Training mode</h3>
      <p className="muted">Practice on this till with nothing real touched: orders stay on this device in a separate store, nothing is sent to the server, no one is charged and nothing prints. A red banner shows on every screen until a manager ends it. Orders already waiting to sync are kept safe and sent when you leave training mode.</p>
      {on ? <><button className="primary sm" onClick={() => setTraining(false)}>Leave training mode</button> <button className="secondary sm" onClick={async () => { if (await askConfirm({ title: "Clear practice orders?", message: "Clear everything practised so far?", ok: "Clear", cancel: "Keep" })) resetPracticeData(); }}>Clear practice orders</button></> : (
        <button className="secondary sm" disabled={!!shift} title={shift ? "Close your shift first" : undefined} onClick={async () => { if (await askConfirm({ title: "Start training mode?", message: "Start training mode on this till? Real selling stops until a manager ends it.", ok: "Start training", cancel: "Cancel" })) setTraining(true); }}>Start training mode on this till</button>
      )}
      {shift && !on && <p className="muted">Close your open shift before starting training mode.</p>}
    </div>
  );
}
