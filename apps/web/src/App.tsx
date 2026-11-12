import { useEffect, useState } from "react";
import { getDeviceCode, setDeviceCode } from "./db";
import { usePending, useReference, useSyncStatus } from "./hooks";
import { startSync, syncNow } from "./sync";
import { useStaff } from "./auth";
import { useFailedPrintJobs, useNewOnlineOrders } from "./hooks";
import { needsEnrollment, useDevice } from "./device";
import { Credit } from "./views/Credit";
import { Devices } from "./views/Devices";
import { Enroll } from "./views/Enroll";
import { Login } from "./views/Login";
import { Manager } from "./views/Manager";
import { Online } from "./views/Online";
import { Shop } from "./views/Shop";
import { Orders } from "./views/Orders";
import { Printers } from "./views/Printers";
import { Prices } from "./views/Prices";
import { Kitchen } from "./views/Kitchen";
import { Pos } from "./views/Pos";
import { Queue } from "./views/Queue";

type Route = "pos" | "kitchen" | "queue" | "credit" | "login" | "devices" | "prices" | "printers" | "orders" | "online" | "shop" | "manager";
const routeFromHash = (): Route => {
  const h = location.hash.replace("#/", "").split("?")[0]!.split("/")[0]!;
  return h === "kitchen" || h === "queue" || h === "credit" || h === "login" || h === "devices" || h === "prices" || h === "printers" || h === "orders" || h === "online" || h === "shop" || h === "manager" ? h : "pos";
};

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash());
  const [code, setCode] = useState(getDeviceCode());
  const [customerId, setCustomerId] = useState("");
  const staff = useStaff();
  const device = useDevice();
  const failedJobs = useFailedPrintJobs();
  const newOnline = useNewOnlineOrders();
  const { config, catalog } = useReference();
  const status = useSyncStatus();
  const pending = usePending();

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    const stop = startSync();
    return () => {
      window.removeEventListener("hashchange", onHash);
      stop();
    };
  }, []);

  // The customer ordering page is public: no enrolment, no sign-in, none of the staff chrome.
  if (route === "shop") return <Shop />;

  // Nothing talks to the server until this device is enrolled (queue displays included).
  if (needsEnrollment(device)) return <Enroll online={status.online} />;

  // The queue screen is a public display: no chrome.
  if (route === "queue") return <Queue config={config} />;

  const connected = status.online && status.reachable;
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <b>{config?.name ?? "POS"}</b>
          <span>{config ? `${config.outletName} · ${modeLabel(config.paymentTiming)}` : "waiting for first sync"}</span>
        </div>
        <nav>
          <a href="#/pos" className={route === "pos" ? "on" : ""}>POS</a>
          <a href="#/kitchen" className={route === "kitchen" ? "on" : ""}>Kitchen</a>
          <a href="#/online" className={route === "online" ? "on" : ""}>Online{newOnline > 0 ? <b className="dot">{newOnline}</b> : null}</a>
          <a href="#/credit" className={route === "credit" ? "on" : ""}>Credit</a>
          {staff && staff.role !== "cashier" && catalog && <a href="#/printers" className={route === "printers" ? "on" : ""}>Printers{failedJobs > 0 ? <b className="dot">{failedJobs}</b> : null}</a>}
          {device.required && staff && <a href="#/manager" className={route === "manager" ? "on" : ""}>Manager</a>}
          {device.required && staff && <a href="#/orders" className={route === "orders" ? "on" : ""}>Orders</a>}
          {staff && staff.role !== "cashier" && catalog && <a href="#/prices" className={route === "prices" ? "on" : ""}>Prices</a>}
          {device.required && staff && staff.role !== "cashier" && <a href="#/devices" className={route === "devices" ? "on" : ""}>Devices</a>}
          <a href="#/queue" target="_blank" rel="noreferrer">Queue screen ↗</a>
        </nav>
        <div className="right">
          <a href="#/login" className="staffbtn" title={staff ? "Signed in" : "Sign in"}>{staff ? `${staff.name} · ${staff.role}` : "Sign in"}</a>
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
          <button className={`pill ${connected ? "ok" : "off"}`} onClick={() => void syncNow()} title="Tap to sync now">
            <i /> {connected ? "Online" : "Offline"}
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
          <Manager config={config} />
        ) : route === "orders" ? (
          <Orders config={config} />
        ) : route === "prices" ? (
          <Prices catalog={catalog} outletId={config.outletName} />
        ) : route === "devices" ? (
          <Devices />
        ) : route === "login" ? (
          <Login online={connected} />
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
