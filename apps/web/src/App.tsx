import { useEffect, useState } from "react";
import { tellNotice } from "./proto/confirm";
import { ConfirmHost } from "./proto/confirm";
import "./backoffice.css";
import { getDeviceCode, setDeviceCode } from "./db";
import { usePending, useReference, useSyncStatus } from "./hooks";
import { startSync, syncNow } from "./sync";
import { hasPerm, authHeader, useStaff } from "./auth";
import { useFailedPrintJobs, useNewOnlineOrders } from "./hooks";
import { needsEnrollment, useDevice } from "./device";
import { Credit } from "./views/Credit";
import { Devices } from "./views/Devices";
import { Enroll } from "./views/Enroll";
import { Login } from "./views/Login";
import { Manager } from "./views/Manager";
import { Online } from "./views/Online";
import { ErrorBoundary } from "./views/ErrorBoundary";
import { Shop } from "./views/Shop";
import { Orders } from "./views/Orders";
import { Dashboard } from "./views/Dashboard";
import { Settings } from "./views/Settings";
import { TillHeader } from "./views/TillHeader";
import { TEXT_SCALE, usePrefs } from "./prefs";
import { Tabs } from "./views/Tabs";
import { Printers } from "./views/Printers";
import { Prices } from "./views/Prices";
import { PricebookEditor } from "./views/PricebookEditor";
import { TelegramSignIn } from "./views/TelegramSignIn";
import { Kiosk } from "./views/Kiosk";
import { onRouteChange, routeParts } from "./nav";
import "./orderViews";
import { isTraining } from "./training";
import { loadShiftRequired, syncShift } from "./shift";
import { lockNow, useIdleLock } from "./lock";
import { Kitchen } from "./views/Kitchen";
import { Clock } from "./views/Clock";
import { Pair } from "./views/Pair";
import { Pos } from "./views/Pos";
import { Queue } from "./views/Queue";
import { CustomerDisplay } from "./views/CustomerDisplay";

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const readableOnWhite = (hex: string) => /^#[0-9a-fA-F]{6}$/.test(hex) && 1.05 / (lum(hex) + 0.05) >= 3;
const softOf = (hex: string) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) + (255 - parseInt(hex.slice(i, i + 2), 16)) * 0.88).toString(16).padStart(2, "0")).join("");

/**
 * The staff screens follow the merchant's theme (Q&A F-2); a person can pick their own colour instead, which is theirs alone and follows them to any
 * device. A colour too pale to read under service is never applied.
 */
function useStaffTheme(signedIn: boolean) {
  const [own, setOwn] = useState<string | null>(null);
  const [shop, setShop] = useState<string | null>(null);
  useEffect(() => { void fetch("/api/brand").then((r) => (r.ok ? r.json() : null)).then((b: { primary?: string } | null) => setShop(b?.primary ?? null)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!signedIn) { setOwn(null); return; }
    void fetch("/api/auth/theme", { headers: authHeader() }).then((r) => (r.ok ? r.json() : null)).then((j: { primary: string | null } | null) => setOwn(j?.primary ?? null)).catch(() => undefined);
  }, [signedIn]);
  const colour = own && readableOnWhite(own) ? own : shop && readableOnWhite(shop) ? shop : null;
  const style = (colour ? { "--orange": colour, "--selected": softOf(colour) } : undefined) as React.CSSProperties | undefined;
  return { own, shop, setOwn, style };
}

type Route = "dashboard" | "settings" | "tabs" | "display" | "pos" | "kitchen" | "queue" | "credit" | "login" | "devices" | "prices" | "printers" | "orders" | "online" | "shop" | "kiosk" | "manager" | "tg" | "pricebook" | "pair" | "clock";
const routeFromHash = (): Route => {
  const h = routeParts()[0] ?? "";
  return h === "dashboard" || h === "settings" || h === "tabs" || h === "display" || h === "kitchen" || h === "queue" || h === "credit" || h === "login" || h === "devices" || h === "prices" || h === "printers" || h === "orders" || h === "online" || h === "shop" || h === "kiosk" || h === "manager" || h === "pos" || h === "tg" || h === "pricebook" || h === "pair" || h === "clock" ? h : "manager";
};

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [code, setCode] = useState(getDeviceCode());
  const [customerId, setCustomerId] = useState("");
  const staff = useStaff();
  const theme = useStaffTheme(!!staff);
  const device = useDevice();
  const failedJobs = useFailedPrintJobs();
  const newOnline = useNewOnlineOrders();
  const { config, catalog } = useReference();
  const status = useSyncStatus();
  const pending = usePending();
  const prefs = usePrefs();
  useIdleLock();
  // Whoever signs in, the till asks the server which shift they have open (it may have been opened or closed on another device) and the shop's
  // shift rules, straight away: "Open your shift first", the drawer and the update warning all depend on them.
  useEffect(() => { if (staff && !isTraining()) { void syncShift(); void loadShiftRequired(); } }, [staff?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    const off = onRouteChange(onHash);
    const stop = startSync();
    return () => {
      off();
      stop();
    };
  }, []);

  // The customer ordering page is public: no enrolment, no sign-in, none of the staff chrome.
  if (route === "shop") return <ErrorBoundary><Shop /></ErrorBoundary>;
  // The page a customer's phone opens from the kiosk's QR code: public, like the shop.
  if (route === "pair") return <ErrorBoundary><Pair /></ErrorBoundary>;
  // The in-store self-order kiosk is public too: it is opened full screen on the kiosk tablet (/kiosk?outlet=CODE).
  if (route === "kiosk") return <ErrorBoundary><Kiosk /></ErrorBoundary>;

  // The customer-facing screen (items, totals, payment QR): public, full screen, fed by the till on the same device.
  if (route === "display") return <ErrorBoundary><CustomerDisplay /></ErrorBoundary>;

  // A one-time link from the Telegram bot: it enrols this browser and signs the person in, so it comes before the enrolment screen.
  if (route === "tg") return <TelegramSignIn />;

  // Nothing talks to the server until this device is enrolled (queue displays included).
  if (needsEnrollment(device)) return <Enroll online={status.online} />;

  // Clocking in and out needs an enrolled till but nobody signed in: full screen, no navigation.
  if (route === "clock") return <ErrorBoundary><Clock /></ErrorBoundary>;

  // The queue screen is a public display: no chrome.
  if (route === "queue") return <Queue config={config} />;

  const connected = status.online && status.reachable;
  // The till screens share the prototype's header and its text scale; the back-office pages keep the wider navigation bar.
  const tillStyle = route === "pos" || route === "dashboard" || route === "orders" || route === "settings" || route === "login";
  const hasTables = !!config && config.paymentTiming === "postpay" && config.serviceMode !== "retail" && !!catalog?.channels.some((c) => c.active && c.kind === "dine_in"); // a retail outlet has no tables
  // The staff screens outside the till. The customer-facing ones (shop, kiosk, queue, display) keep the shop's own look.
  const backOffice = route === "manager" || route === "prices" || route === "pricebook" || route === "printers" || route === "devices" || route === "online" || route === "credit" || route === "tabs";
  const shellStyle = { ...(staff ? theme.style : {}), ...(tillStyle ? { "--t-scale": TEXT_SCALE[prefs.textSize] } : {}) } as React.CSSProperties;
  return (
    <div className={`shell ${route === "pos" ? "till-route" : ""} ${tillStyle ? "tillshell" : ""} ${backOffice ? "backoffice" : ""}`} style={shellStyle}>
      <ConfirmHost />
      {tillStyle && route !== "pos" && !(route === "login" && !staff) && <TillHeader route={route} config={config ?? null} connected={connected} pending={pending} newOnline={newOnline} hasTables={hasTables} onSync={() => void syncNow()} syncError={status.error} />}
      {!tillStyle && <header className="top">
        <div className="brand">
          <b>{config?.name ?? "POS"}</b>
          <span>{config ? `${config.outletName} · ${modeLabel(config.paymentTiming)}` : "waiting for first sync"}</span>
        </div>
        <nav>
          {/* This version is for running the shop: orders, printing, members, menu and devices. The till (POS), Kitchen, Credit,
              Orders and Queue screens still exist at /pos, /kitchen, /credit, /orders and /queue; they are just not in the bar. */}
          {staff && <a href="/dashboard" className={(route as string) === "dashboard" ? "on" : ""}>Home</a>}
          {staff && <a href="/pos" className={(route as string) === "pos" ? "on" : ""}>Till</a>}
          {staff && <a href="/orders" className={(route as string) === "orders" ? "on" : ""}>Orders</a>}
          {device.required && staff && <a href="/manager" className={route === "manager" ? "on" : ""}>Manager</a>}
          <a href="/online" className={route === "online" ? "on" : ""}>Online{newOnline > 0 ? <b className="dot">{newOnline}</b> : null}</a>
          {/* Printers, Prices and Devices live under Settings > Menu & prices; Printers shows here only when a print job has failed. */}
          {hasPerm(staff, "print.manage") && catalog && failedJobs > 0 && <a href="/printers" className={route === "printers" ? "on" : ""}>Printers<b className="dot">{failedJobs}</b></a>}
          {staff && <a href="/settings" className={(route as string) === "settings" ? "on" : ""}>Settings</a>}
        </nav>
        <div className="right">
          {staff && (
            <label className="dev colourpick" title="Your own colour for these screens. Only you see it; it follows you to any device. Leave it and you see the shop's colours.">
              <span className="lbl">Colour</span>
              <input type="color" aria-label="My colour" value={theme.own ?? theme.shop ?? "#ea7016"} onChange={async (e) => {
                const r = await fetch("/api/auth/theme", { method: "PUT", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ primary: e.target.value }) });
                if (r.ok) theme.setOwn(e.target.value.toUpperCase()); else void tellNotice({ title: "Colour not saved", message: ((await r.json().catch(() => ({}))) as { message?: string }).message ?? "That colour was not saved." });
              }} />
              {theme.own && <button className="secondary sm" onClick={async () => { await fetch("/api/auth/theme", { method: "PUT", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ primary: null }) }); theme.setOwn(null); }}>Reset</button>}
            </label>
          )}
          <a href="/login" className="staffbtn" title={staff ? "Signed in" : "Sign in"}>{staff ? `${staff.name} · ${staff.role}` : "Sign in"}</a>
          {staff && <button className="secondary sm" title="Lock this till. Your shift and the order on screen stay as they are." onClick={() => void lockNow(false)}>Lock</button>}
          <label className="dev" title="Each device has its own letter so queue numbers never clash offline">
            <span className="lbl">Device</span>
            <select
              value={code}
              onChange={(e) => {
                setDeviceCode(e.target.value);
                setCode(e.target.value);
              }}
            >
              {["A", "B", "C", "D"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <button className={`pill ${connected ? "ok" : "off"}`} onClick={() => void syncNow()} title={status.error ? `Last sync problem: ${status.error}. Tap to try again.` : "Tap to sync now"}>
            <i /> {isTraining() ? "Practice" : connected ? "Online" : "Offline"}
            {pending > 0 ? ` · ${pending} to sync` : ""}
          </button>
        </div>
      </header>}
      <main>
        {!config || !catalog ? (
          <div className="empty">
            <h2>Connect once to load the menu</h2>
            <p>The first start needs the server. After that the POS works without a network.</p>
          </div>
        ) : !catalog.channels.some((c) => c.active) ? (
          <div className="empty"><h2>No channels are switched on</h2><p>A manager needs to switch on at least one channel under Prices.</p></div>
        ) : route === "kitchen" ? (
          <Kitchen config={config} catalog={catalog} />
        ) : route === "online" ? (
          <Online config={config} online={connected} />
        ) : route === "printers" ? (
          <Printers catalog={catalog} />
        ) : route === "dashboard" ? (
          <Dashboard config={config} />
        ) : route === "settings" ? (
          <Settings catalog={catalog} />
        ) : route === "manager" ? (
          <Manager config={config} catalog={catalog} />
        ) : route === "tabs" ? (
          <Tabs />
        ) : route === "orders" ? (
          <Orders config={config} />
        ) : route === "pricebook" ? (
          <PricebookEditor catalog={catalog} bookId={routeParts()[1] ?? ""} />
        ) : route === "prices" ? (
          <Prices catalog={catalog} outletId={config.outletName} />
        ) : route === "devices" ? (
          <Devices />
        ) : route === "login" ? (
          <Login online={connected} problem={status.error} />
        ) : route === "credit" ? (
          <Credit customerId={customerId} setCustomerId={setCustomerId} online={connected} />
        ) : (
          <Pos config={config} catalog={catalog} online={connected} customerId={customerId} setCustomerId={setCustomerId} header={<TillHeader bare route={route} config={config ?? null} connected={connected} pending={pending} newOnline={newOnline} hasTables={hasTables} onSync={() => void syncNow()} syncError={status.error} />} />
        )}
      </main>
    </div>
  );
}

const modeLabel = (t: string) => (t === "prepay" ? "Fast serve" : t === "postpay" ? "Restaurant" : "Delivery");
