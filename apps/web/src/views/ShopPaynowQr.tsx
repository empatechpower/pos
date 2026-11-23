import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { formatMoney } from "@pos/core";

/**
 * The phone shop's own-PayNow QR: the server issues a QR for what is still owed (valid a few minutes), this draws it with a countdown,
 * and asks the server whether the bank has confirmed it. When the minutes are up the QR is taken away (not greyed) and a new one can be made.
 */
export function ShopPaynowQr({ orderId, amountCents, tx, onPaid, onClose }: { orderId: string; amountCents: number; tx: (s: string, v?: Record<string, string>) => string; onPaid: () => void; onClose: () => void }) {
  const [qr, setQr] = useState<null | { paymentId: string; img: string; expiresAt: number }>(null);
  const [now, setNow] = useState(Date.now());
  const [problem, setProblem] = useState("");
  const [paid, setPaid] = useState(false);

  const make = useCallback(async () => {
    setProblem(""); setQr(null);
    const r = await fetch(`/api/shop/orders/${orderId}/pay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "paynow", display: "qr", surface: "online" }) }).catch(() => null);
    const j = (await r?.json().catch(() => null)) as { url?: string; paymentId?: string; expiresAt?: number; error?: string; minCents?: number; maxCents?: number } | null;
    if (!r || !r.ok || !j?.url || !j.paymentId || !j.expiresAt) {
      setProblem(j?.error === "amount_not_allowed" ? tx("PayNow can't be used for this amount. You can pay at the counter.") : tx("Could not get a PayNow QR. Please try again or pay at the counter."));
      return;
    }
    setQr({ paymentId: j.paymentId, img: await QRCode.toDataURL(j.url, { margin: 4, width: 560 }), expiresAt: j.expiresAt });
  }, [orderId, tx]);
  useEffect(() => { void make(); }, [make]);

  useEffect(() => {
    if (!qr || paid) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(async () => {
      const r = await fetch(`/api/payments/paynow/status/${qr.paymentId}`).catch(() => null);
      if (r?.ok && ((await r.json()) as { state: string }).state === "PAID") { setPaid(true); onPaid(); }
    }, 2500);
    return () => { window.clearInterval(tick); window.clearInterval(poll); };
  }, [qr?.paymentId, paid]);

  const left = qr ? Math.max(0, Math.ceil((qr.expiresAt - now) / 1000)) : 0;
  return (
    <div className="e2e-card" style={{ textAlign: "center" }}>
      <h3>{paid ? tx("Payment received") : `${tx("Scan to pay")} ${formatMoney(amountCents)}`}</h3>
      {problem && <p className="e2e-note" role="alert">{problem}</p>}
      {paid ? <p className="e2e-sub">{tx("Thank you. Your payment has been confirmed.")}</p> : qr && left > 0 ? (
        <>
          <img src={qr.img} alt="PayNow QR" width={260} height={260} style={{ maxWidth: "100%" }} />
          <p className="e2e-sub">{tx("Open your banking app, scan this PayNow QR, and confirm the amount. This page updates on its own once your payment lands.")}</p>
          <p className="e2e-note">{tx("QR valid for {t}", { t: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` })}</p>
        </>
      ) : qr ? (
        <>
          <p className="e2e-sub"><b>{tx("This QR has expired.")}</b></p>
          <button className="e2e-cta" onClick={() => void make()}><span>{tx("Generate new QR")}</span></button>
        </>
      ) : !problem ? <p className="e2e-sub">{tx("Getting your QR…")}</p> : null}
      {!paid && <button className="e2e-back" onClick={onClose}>{tx("Pay at the counter instead")}</button>}
    </div>
  );
}
