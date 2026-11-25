import { useState } from "react";
import { formatMoney, recordedTender } from "@pos/core";

/** Cash, member credit, a PayNow QR, practice, or a recorded tender (card, debit, manualcard, check, giftcard: taken outside the till). */
export type Tender = "cash" | "credit" | "qr" | "mock" | "card" | "debit" | "manualcard" | "check" | "giftcard" | `ct-${string}`;
export interface TenderOption { id: Tender; label: string; disabled?: boolean; why?: string; /** Off until a manager shows it in Settings. */ optional?: boolean }

/**
 * Payment replaces the menu area while the ticket stays in view. Cash has a keypad and shows the change; the other ways of paying ask for
 * their own steps when Done is pressed.
 */
export function PayPanel({ totalCents, title, venue, tenders, busy, onBack, onDone, onSplit, partial }: { totalCents: number; title: string; /** The shop and table, shown at the right of the heading. */ venue?: string; tenders: TenderOption[]; busy: boolean; onBack: () => void; onDone: (tender: Tender, receivedCents: number) => void; /** Shows Split Bill beside Back. */ onSplit?: () => void; /** Cash may pay part of what is due (a check of a split bill). */ partial?: boolean }) {
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
  // The markup and class names are the prototype's own (proto-reference/index.html, payPanelHTML): it takes the catalogue's place.
  return (
    <section className="catalog" id="catalog" aria-label="Payment">
      <div className="paypanel">
        <div className="paypanel-head"><strong>Payment · {title}</strong>{venue && <span className="muted">{venue}</span>}</div>
        <div className="payfigures">
          <div>Balance Due<strong>{formatMoney(totalCents)}</strong></div>
          <div>Amount Tendered<strong className="amount">{tender === "cash" ? formatMoney(valid ? received : 0) : formatMoney(totalCents)}</strong></div>
          <div>Change<strong className="change">{tender === "cash" ? formatMoney(cashOk ? Math.max(0, received - totalCents) : 0) : formatMoney(0)}</strong></div>
        </div>
        {tender === "cash" ? (
          <>
            <label className="cash-entry">Received<input id="cash" type="text" inputMode="decimal" autoComplete="off" placeholder="0.00" aria-label="Amount received" value={value} onChange={(e) => setValue(e.target.value)} /></label>
            <div className="cashpad">
              {["1", "2", "3", "$5", "4", "5", "6", "$10", "7", "8", "9", "$50", "C", "0", ".", "⌫"].map((k) => <button key={k} className={k.startsWith("$") ? "quick" : ""} onClick={() => key(k)}>{k}</button>)}
            </div>
            <p className="error" role="status">{!value ? "Enter the amount received." : !valid ? "Enter a valid amount, with up to two decimal places." : cashOk ? (received >= totalCents ? `Change due: ${formatMoney(received - totalCents)}` : `Part payment — ${formatMoney(totalCents - received)} will still be due on this check.`) : `Still due: ${formatMoney(Math.max(0, totalCents - received))}`}</p>
          </>
        ) : (
          <>
            <div className="tender-card">{tender === "credit" ? "Member credit" : tender === "qr" ? "PayNow QR" : recordedTender(tender)?.label ?? (tender.startsWith("ct-") ? cur?.label : undefined) ?? "Card / PayNow (practice)"} payment</div>
            <p className="connectionnote">{cur?.why ?? (tender === "qr" ? "A QR for the exact amount is shown next." : tender === "credit" ? "The member's credit is charged when you press Done." : recordedTender(tender) ? `Take the ${recordedTender(tender)!.label.toLowerCase()} payment for the full amount first. Press Done only once it has gone through: the till records it and does not charge anything itself.` : tender.startsWith("ct-") ? `Recorded as ${cur?.label ?? "this payment type"} for the full amount. The till does not charge anything itself.` : "Practice only: no money moves.")}</p>
          </>
        )}
        <div className="payment-bottom">
          <div className="choices">{tenders.map((t) => <button key={t.id} className={t.id === tender ? "selected" : ""} disabled={t.disabled} title={t.why} onClick={() => setTender(t.id)}>{t.label}</button>)}</div>
          <button className="primary donepay" disabled={busy || (tender === "cash" ? !cashOk : !!cur?.disabled)} onClick={() => onDone(tender, tender === "cash" ? received : totalCents)} aria-label="Complete payment">Done</button>
        </div>
        <div className="actions"><button onClick={onBack}>← Back / Cancel</button>{onSplit && <button onClick={onSplit}>Split Bill</button>}</div>
      </div>
    </section>
  );
}
