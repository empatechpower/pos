import { useEffect, useRef, useState } from "react";
import { formatMoney, newId } from "@pos/core";
import { deviceId } from "../db";
import { useStaff } from "../auth";
import { getBalance, topUp } from "../wallet";

const PRESETS = [1000, 2000, 5000, 10000];

/** Counter screen: look up a customer, take cash, add credit. */
export function Credit({ customerId, setCustomerId, online }: { customerId: string; setCustomerId: (id: string) => void; online: boolean }) {
  const staff = useStaff();
  const [balance, setBalance] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per attempt: if the request is retried after a dropped connection it posts at most once.
  const attemptKey = useRef(newId());

  const refresh = async () => setBalance(customerId ? await getBalance(customerId) : null);
  useEffect(() => {
    void refresh();
  }, [customerId, online, staff]);

  async function add(cents: number) {
    if (!customerId || cents <= 0 || busy) return;
    setBusy(true);
    setMsg(null);
    const r = await topUp(customerId, cents, attemptKey.current, deviceId());
    setBusy(false);
    if (r.ok) {
      attemptKey.current = newId();
      setBalance(r.balanceCents);
      setCustom("");
      setMsg(`Added ${formatMoney(cents)}. New balance ${formatMoney(r.balanceCents)}.`);
    } else if (r.reason === "over_limit") {
      setMsg(`Cashiers can add up to ${formatMoney(r.limitCents)} at a time. Ask a manager for more.`);
    } else if (r.reason === "signin_required") {
      setMsg("Your session has ended. Sign in again. Nothing was added.");
    } else if (r.reason === "not_allowed") {
      setMsg("This account isn't allowed to add credit.");
    } else {
      setMsg("Could not reach the server. Nothing was added. Check the connection and try again.");
    }
  }

  const customCents = Math.round(Number(custom) * 100);
  return (
    <div className="credit">
      <h2>Top up credit</h2>
      <label className="field">
        Customer (phone or member code)
        <input value={customerId} onChange={(e) => setCustomerId(e.target.value.trim())} placeholder="e.g. 91234567" inputMode="tel" />
      </label>
      {customerId && (
        <p className="bal">
          Balance: <b>{balance === null ? "—" : formatMoney(balance)}</b>
        </p>
      )}
      {!staff && <div className="flash">Sign in as staff to top up credit. <a href="#/login">Sign in</a></div>}
      {!online && <div className="flash">Credit needs a connection. Cash top-ups can't be recorded offline.</div>}
      <div className="presets">
        {PRESETS.map((c) => (
          <button key={c} className="secondary" disabled={!staff || !customerId || !online || busy} onClick={() => void add(c)}>
            + {formatMoney(c)}
          </button>
        ))}
      </div>
      <div className="custom">
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Other amount (S$)" inputMode="decimal" />
        <button className="primary sm" disabled={!staff || !customerId || !online || busy || !(customCents > 0)} onClick={() => void add(customCents)}>
          Add credit
        </button>
      </div>
      <p className="muted">Take the cash first, then add the same amount here.</p>
      {msg && <div className="flash">{msg}</div>}
    </div>
  );
}
