import { useEffect, useState } from "react";
import { getDeviceCode, setDeviceCode } from "./db";
import { usePending, useReference, useSyncStatus } from "./hooks";
import { startSync, syncNow } from "./sync";
import { authHeader, useStaff } from "./auth";
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
import { Tabs } from "./views/Tabs";
import { Printers } from "./views/Printers";
import { Prices } from "./views/Prices";
import { PricebookEditor } from "./views/PricebookEditor";
import { TelegramSignIn } from "./views/TelegramSignIn";
import { Kiosk } from "./views/Kiosk";
import { onRouteChange, routeParts } from "./nav";
import "./orderViews";
import { isTraining } from "./training";
import { lockNow, useIdleLock } from "./lock";
import { Kitchen } from "./views/Kitchen";
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

type Route = "tabs" | "display" | "pos" | "kitchen" | "queue" | "credit" | "login" | "devices" | "prices" | "printers" | "orders" | "online" | "shop" | "kiosk" | "manager" | "tg" | "pricebook" | "pair";
const routeFromHash = (): Route => {
  const h = routeParts()[0] ?? "";
  return h === "tabs" || h === "display" || h === "kitchen" || h === "queue" || h === "credit" || h === "login" || h === "devices" || h === "prices" || h === "printers" || h === "orders" || h === "online" || h === "shop" || h === "kiosk" || h === "manager" || h === "pos" || h === "tg" || h === "pricebook" || h === "pair" ? h : "manager";
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
  useIdleLock();

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

  // The queue screen is a public display: no chrome.
  if (route === "queue") return <Queue config={config} />;

  const connected = status.online && status.reachable;
  return (
    <div className={`shell ${route === "pos" ? "till-route" : ""}`} style={staff ? theme.style : undefined}>
      <header className="top">
        <div className="brand">
          <b>{config?.name ?? "POS"}</b>
          <span>{config ? `${config.outletName} · ${modeLabel(config.paymentTiming)}` : "waiting for first sync"}</span>
        </div>
        <nav>
          {/* This version is for running the shop: orders, printing, members, menu and devices. The till (POS), Kitchen, Credit,
              Orders and Queue screens still exist at /pos, /kitchen, /credit, /orders and /queue; they are just not in the bar. */}
          {device.required && staff && <a href="/manager" className={route === "manager" ? "on" : ""}>Manager</a>}
          <a href="/online" className={route === "online" ? "on" : ""}>Online{newOnline > 0 ? <b className="dot">{newOnline}</b> : null}</a>
          {staff && staff.role !== "cashier" && catalog && <a href="/printers" className={route === "printers" ? "on" : ""}>Printers{failedJobs > 0 ? <b className="dot">{failedJobs}</b> : null}</a>}
          {staff && staff.role !== "cashier" && catalog && <a href="/prices" className={route === "prices" ? "on" : ""}>Prices</a>}
          {device.required && staff && staff.role !== "cashier" && <a href="/devices" className={route === "devices" ? "on" : ""}>Devices</a>}
        </nav>
        <div className="right">
          {staff && (
            <label className="dev" title="Your own colour for these screens. Only you see it; it follows you to any device. Leave it and you see the shop's colours.">
              Colour
              <input type="color" aria-label="My colour" value={theme.own ?? theme.shop ?? "#ea7016"} onChange={async (e) => {
                const r = await fetch("/api/auth/theme", { method: "PUT", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ primary: e.target.value }) });
                if (r.ok) theme.setOwn(e.target.value.toUpperCase()); else window.alert(((await r.json().catch(() => ({}))) as { message?: string }).message ?? "That colour was not saved.");
              }} />
              {theme.own && <button className="secondary sm" onClick={async () => { await fetch("/api/auth/theme", { method: "PUT", headers: { "content-type": "application/json", ...authHeader() }, body: JSON.stringify({ primary: null }) }); theme.setOwn(null); }}>Reset</button>}
            </label>
          )}
          <a href="/login" className="staffbtn" title={staff ? "Signed in" : "Sign in"}>{staff ? `${staff.name} · ${staff.role}` : "Sign in"}</a>
          {staff && <button className="secondary sm" title="Lock this till. Your shift and the order on screen stay as they are." onClick={() => void lockNow(false)}>Lock</button>}
          <label className="dev" title="Each device has its own letter so queue numbers never clash offline">
            Device
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
      </header>
      <main>
        {!config || !catalog ? (
          <div className="empty">
            <h2>Connect once to load the menu</h2>
            <p>The first start needs the server. After that the POS works without a network.</p>
          </div>
        ) : !catalog.channels.some((c) => c.active) ? (
          <div className="empty"><h2>No channels are switched on</h2><p>A manager needs to switch on at least one channel under Prices.</p></div>
        ) : route === "kitchen" ? (
          <Kitchen config={config} />
        ) : route === "online" ? (
          <Online config={config} online={connected} />
        ) : route === "printers" ? (
          <Printers catalog={catalog} />
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
          <Pos config={config} catalog={catalog} online={connected} customerId={customerId} setCustomerId={setCustomerId} />
        )}
      </main>
    </div>
  );
}

const modeLabel = (t: string) => (t === "prepay" ? "Fast serve" : t === "postpay" ? "Restaurant" : "Delivery");
