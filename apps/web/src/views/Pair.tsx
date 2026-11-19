import { useEffect, useState } from "react";
import { readableOn } from "@pos/core";
import { Login, tint, type Info } from "./Shop";
import { tx, useLang } from "../shopI18n";
import "../shopProto.css";

/**
 * The customer's phone, opened from the kiosk's QR code (or by typing the kiosk's 6-character code at /pair).
 * The QR proves nothing: the customer signs in HERE, with their own phone, then confirms "this is me". Only then does the kiosk
 * receive that member. It shares the shop's sign-in and its saved session (the same one the phone shop uses).
 */

const LS_MEMBER = "shop.member";
const cleanCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
interface Me { name: string | null; phone: string | null; email: string | null; pointsBalance: number }

export function Pair() {
  useLang();
  const [info, setInfo] = useState<Info | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState(() => cleanCode(new URLSearchParams(location.search).get("code") ?? ""));
  const [typed, setTyped] = useState("");
  const [step, setStep] = useState<"loading" | "code" | "signin" | "confirm" | "done">("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/shop/info")
      .then(async (r) => { if (!r.ok) throw new Error("bad"); setInfo((await r.json()) as Info); })
      .catch(() => setFailed(true));
  }, []);

  /** Who is signed in on this phone, if anyone: a saved session is checked, never assumed. */
  const whoAmI = async () => {
    const t = localStorage.getItem(LS_MEMBER);
    if (!t) return setStep("signin");
    const r = await fetch("/api/shop/me", { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    if (r?.ok) {
      setMe(((await r.json()) as { member: Me }).member);
      setStep("confirm");
    } else {
      if (r?.status === 401) localStorage.removeItem(LS_MEMBER);
      setStep("signin");
    }
  };
  useEffect(() => {
    if (!info) return;
    if (code.length !== 6) return setStep("code");
    void whoAmI();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, code]);

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    const r = await fetch("/api/shop/auth/kiosk/attach", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem(LS_MEMBER) ?? ""}` }, body: JSON.stringify({ code }) }).catch(() => null);
    setBusy(false);
    if (r?.ok) return setStep("done");
    if (r?.status === 401) { localStorage.removeItem(LS_MEMBER); return setStep("signin"); }
    setErr(!r ? tx("No connection. Please try again.") : r.status === 409 ? tx("That code was already used. Tap Start on the kiosk for a new one.") : r.status === 404 ? tx("That code wasn't found, or it has expired. Check the code on the kiosk screen.") : tx("Something went wrong. Please try again."));
  };

  const switchAccount = () => {
    const t = localStorage.getItem(LS_MEMBER);
    if (t) void fetch("/api/shop/auth/logout", { method: "POST", headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    localStorage.removeItem(LS_MEMBER);
    setMe(null);
    setErr(null);
    setStep("signin");
  };

  if (failed) return <div className="shop"><div className="shop-msg"><h2>{tx("Sign-in isn't available right now")}</h2><p>{tx("Please try again in a moment.")}</p></div></div>;
  if (!info) return <div className="shop"><div className="shop-msg"><p>{tx("Loading…")}</p></div></div>;
  const b = info.brand;
  const theme = { "--brand": b.primary, "--accent": b.accent, "--accent-ink": readableOn(b.accent), "--soft": tint(b.accent), "--brand-ink": b.ink } as React.CSSProperties;
  const head = (title: string, sub: string) => (
    <>
      {b.logoUrl && <img className="e2e-logo" src={b.logoUrl} alt={info.name} />}
      <h2 className="e2e-title">{title}</h2>
      <p className="e2e-sub">{sub}</p>
    </>
  );

  return (
    <div className="shop" style={theme}>
      {step === "signin" ? (
        <Login info={info} welcome={0} loginError={null} noGuest onGuest={() => undefined} onDone={(t) => { localStorage.setItem(LS_MEMBER, t); void whoAmI(); }} />
      ) : (
        <div className="e2e-scroll login-page">
          {step === "loading" && <p className="e2e-sub">{tx("Loading…")}</p>}
          {step === "code" && (
            <>
              {head(tx("Sign in to the kiosk"), tx("Type the 6-character code shown on the kiosk screen."))}
              <input className="e2e-input" style={{ marginTop: 18, textAlign: "center", letterSpacing: ".3em", fontSize: 26, fontWeight: 800, textTransform: "uppercase" }} value={typed} maxLength={6} autoCapitalize="characters" autoComplete="off" spellCheck={false} inputMode="text" placeholder="ABC123" aria-label={tx("Kiosk code")} onChange={(e) => setTyped(cleanCode(e.target.value))} />
              <button className="shop-primary" style={{ marginTop: 14, width: "100%" }} disabled={typed.length !== 6} onClick={() => setCode(typed)}>{tx("Continue")}</button>
            </>
          )}
          {step === "confirm" && me && (
            <>
              {head(tx("Sign in to the kiosk?"), tx("Your kiosk order will be under this account."))}
              <div className="login-btn" style={{ marginTop: 18, cursor: "default", justifyContent: "center", flexDirection: "column", gap: 2, padding: "14px 12px" }}>
                <b style={{ fontSize: 20 }}>{me.name || me.phone || me.email || tx("Member")}</b>
                {(me.name && (me.phone || me.email)) ? <span style={{ opacity: .7 }}>{me.phone || me.email}</span> : null}
                <span style={{ opacity: .7 }}>{me.pointsBalance.toLocaleString()} {tx("points")}</span>
              </div>
              {err && <p className="login-err" role="alert">{err}</p>}
              <button className="shop-primary" style={{ marginTop: 14, width: "100%" }} disabled={busy} onClick={() => void confirm()}>{busy ? tx("Signing in…") : tx("Yes, that's me")}</button>
              <button className="login-btn" style={{ marginTop: 12 }} disabled={busy} onClick={switchAccount}>{tx("Not me — use another account")}</button>
            </>
          )}
          {step === "done" && (
            <>
              {head(tx("You're signed in on the kiosk"), tx("Carry on at the kiosk. You can put your phone away."))}
              <a className="login-btn" style={{ marginTop: 18, justifyContent: "center", textDecoration: "none" }} href="/shop">{tx("Order from my phone instead")}</a>
            </>
          )}
        </div>
      )}
    </div>
  );
}
