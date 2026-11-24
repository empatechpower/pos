import { useCallback, useEffect, useState } from "react";
import { staffFetch } from "../auth";

export interface MailboxRow { id: string; label: string; kind: "imap" | "gmail"; host: string | null; port: number | null; username: string | null; lastOkAt: number | null; lastError: string | null }

/** The PayNow alert mailboxes set up for this merchant. They are set up by Rezein, so there is nothing to type here: just where to send the bank's alerts. */
export function useMailboxes() {
  const [rows, setRows] = useState<MailboxRow[]>([]);
  const load = useCallback(async () => {
    const r = await staffFetch("/api/settings/mailboxes");
    if ("res" in r && r.res.ok) setRows(((await r.res.json()) as { mailboxes: MailboxRow[] }).mailboxes);
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { rows, reload: load };
}

export function MailboxesPanel({ rows, reload }: { rows: MailboxRow[]; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function test(id: string) {
    setBusy(id); setMsg("");
    const r = await staffFetch(`/api/settings/mailboxes/${id}/test`, { method: "POST", body: {} });
    setBusy(null);
    if (!("res" in r)) return setMsg(r.problem);
    const j = (await r.res.json().catch(() => ({}))) as { ok?: boolean; found?: number; error?: string };
    setMsg(j.ok ? `Working. ${j.found ? `Found ${j.found} bank alert${j.found === 1 ? "" : "s"} from the last 3 days.` : "No bank alerts from the last 3 days yet (that is fine if there were no payments)."}` : j.error ?? "Could not connect.");
    await reload();
  }

  return (
    <div className="e2e-card mailboxes" style={{ marginTop: 10 }}>
      <b>Alert mailbox</b>
      <p className="muted">PayNow alerts go to a mailbox made only for them. Rezein sets it up for you (or uses a dedicated address on your own company domain), so no one has to give us a password of their own. Tell your bank to send its “funds received” alerts to the address below.</p>
      {msg && <div className="flash" role="status">{msg}</div>}
      {rows.length === 0 && <p className="muted">No alert mailbox has been set up for you yet. Ask your Rezein contact, or give us a dedicated address on your company domain.</p>}
      {rows.map((m) => (
        <div className="row" key={m.id} style={{ alignItems: "center" }}>
          <span style={{ flex: 1 }}><b>{m.username}</b> <span className="muted">· {m.label}</span>{m.lastError ? <span className="muted" style={{ color: "#b3261e" }}> · {m.lastError}</span> : m.lastOkAt ? <span className="muted"> · last worked {new Date(m.lastOkAt).toLocaleString("en-GB", { timeZone: "Asia/Singapore" })}</span> : <span className="muted"> · not tested yet</span>}</span>
          <button className="secondary sm" disabled={busy === m.id} onClick={() => void test(m.id)}>{busy === m.id ? "Testing…" : "Test connection"}</button>
        </div>
      ))}
    </div>
  );
}
