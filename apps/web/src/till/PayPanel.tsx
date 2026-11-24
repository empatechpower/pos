import { useState } from "react";
import { formatMoney } from "@pos/core";

export type Tender = "cash" | "credit" | "qr" | "mock";
export interface TenderOption { id: Tender; label: string; disabled?: boolean; why?: string }

/**
 * Payment replaces the menu area while the ticket stays in view. Cash has a keypad and shows the change; the other ways of paying ask for
 * their own steps when Done is pressed.
 */
export function PayPanel({ totalCents, title, tenders, busy, onBack, onDone, onSplit, partial }: { totalCents: number; title: string; tenders: TenderOption[]; busy: boolean; onBack: () => void; onDone: (tender: Tender, receivedCents: number) => void; /** Shows Split Bill beside Back. */ onSplit?: () => void; /** Cash may pay part of what is due (a check of a split bill). */ partial?: boolean }) {
  const [tender, setTender] = useState<Tender>("cash");
  const [value, setValue] = useState("");
  const received = Math.round(Number(value || 0) * 100);
  const valid = /^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})?$/.test(value);
  const cashOk = valid && (partial ? received > 0 : received >= totalCents);
  const key = (k: string) => {
    if (k.startsWith("$")) return setValue(Number(k.slice(1)).toFixed(2));
    if (k === "C") return setValue("");
    if (k === "⌫") return setValue((v) => v.slice(0, -1));
    if (k === ".") return setValue((v) => (v.includes(".") ? v : (v || "0") + "."));
    setValue((v) => ((v.split(".")[1] ?? "").length < 2 && v.length < 10 ? (v === "0" ? k : v + k) : v));
  };
  const cur = tenders.find((t) => t.id === tender);
  return (
    <section className="t-pay-panel" aria-label="Payment">
      <div className="t-payhead"><strong>Payment · {title}</strong></div>
      <div className="t-figures">
        <div>Balance Due<strong>{formatMoney(totalCents)}</strong></div>
        <div>Amount Tendered<strong>{tender === "cash" ? formatMoney(valid ? received : 0) : formatMoney(totalCents)}</strong></div>
        <div>Change<strong className="chg">{tender === "cash" ? formatMoney(cashOk ? Math.max(0, received - totalCents) : 0) : formatMoney(0)}</strong></div>
      </div>
      {tender === "cash" ? (
        <>
          <label className="t-cashin">Received<input inputMode="decimal" autoComplete="off" placeholder="0.00" aria-label="Amount received" value={value} onChange={(e) => setValue(e.target.value)} /></label>
          <div className="t-keypad">
            {["1", "2", "3", "$5", "4", "5", "6", "$10", "7", "8", "9", "$50", "C", "0", ".", "⌫"].map((k) => <button key={k} className={k.startsWith("$") ? "quick" : ""} onClick={() => key(k)}>{k}</button>)}
          </div>
          <p className="t-hint" role="status">{!value ? "Enter the amount received." : !valid ? "Enter a valid amount." : cashOk ? (received >= totalCents ? `Change due: ${formatMoney(received - totalCents)}` : `Part payment: ${formatMoney(totalCents - received)} will still be due`) : `Still due: ${formatMoney(totalCents - received)}`}</p>
        </>
      ) : (
        <div className="t-tendercard">{tender === "credit" ? "Member credit" : tender === "qr" ? "PayNow QR" : "Card / PayNow (practice)"}<small>{cur?.why ?? (tender === "qr" ? "A QR for the exact amount is shown next." : tender === "credit" ? "The member's credit is charged when you press Done." : "")}</small></div>
      )}
      <div className="t-paybottom">
        <div className="t-tenders">{tenders.map((t) => <button key={t.id} className={t.id === tender ? "on" : ""} disabled={t.disabled} title={t.why} onClick={() => setTender(t.id)}>{t.label}</button>)}</div>
        <button className="t-done" disabled={busy || (tender === "cash" ? !cashOk : !!cur?.disabled)} onClick={() => onDone(tender, tender === "cash" ? received : totalCents)} aria-label="Complete payment">Done</button>
      </div>
      <div className="t-payfoot"><button className="t-ghost" onClick={onBack}>← Back / Cancel</button>{onSplit && <button className="t-ghost" onClick={onSplit}>Split Bill</button>}</div>
    </section>
  );
}
