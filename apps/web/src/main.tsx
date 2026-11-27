import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { TrainingBanner } from "./views/TrainingBanner";
import { adoptLegacyHash, installLinkHandler } from "./nav";
import { checkForUpdate, markUpdateReady, setRegistration, setUpdater } from "./pwaUpdate";
import { UpdateBar } from "./views/UpdateBar";
import "./styles.css";

adoptLegacyHash();
// The kiosk installs as its own app that opens on /kiosk; everything else installs from the default manifest.
if (location.pathname === "/kiosk" || location.pathname.startsWith("/kiosk/")) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]') ?? document.head.appendChild(Object.assign(document.createElement("link"), { rel: "manifest" }));
  link.href = "/manifest-kiosk.webmanifest";
}
if (location.pathname === "/display" || location.pathname.startsWith("/display/")) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = "/manifest-display.webmanifest";
}
installLinkHandler();
const onKiosk = location.pathname === "/kiosk" || location.pathname.startsWith("/kiosk/");
// The customer's own pages (shop, pair, display, queue) take a new version at once; the till's staff screens and the kiosk wait to be told.
const staffScreen = !/^\/(shop|pair|display|queue|kiosk)(\/|$)/.test(location.pathname);
/**
 * When a new version may be taken without asking. The owner's rule (decision Q17) is that a till is never restarted under someone in the
 * middle of their work: that still holds, and then the notice waits for "Update now". But a reload, or opening the app, with nothing on the
 * order on screen, or a till nobody is signed in to, takes the new version at once: there is nothing to interrupt, and a reload that kept
 * showing the old version looked to everyone like a caching fault.
 */
const loadedAt = Date.now();
function safeToUpdateNow(): boolean {
  let items = 0;
  try { items = ["pos.bag", "pos.bag.practice"].reduce((n, k) => n + ((JSON.parse(localStorage.getItem(k) ?? "null") as { bag?: unknown[] } | null)?.bag?.length ?? 0), 0); } catch { items = 0; }
  if (items > 0) return false;
  const justOpened = Date.now() - loadedAt < 20_000;
  const nobodySignedIn = !localStorage.getItem("pos.token");
  return justOpened || nobodySignedIn;
}
// A new version asks whether this page handles updates itself (public/sw-takeover.js). Saying yes keeps the rule above; an old copy of the
// app cannot answer, and the new version then takes over from it.
navigator.serviceWorker?.addEventListener("message", (e) => { if ((e.data as { type?: string } | null)?.type === "rezein-handles-updates?") e.ports[0]?.postMessage(true); });
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    if (!onKiosk && staffScreen && safeToUpdateNow()) return void updateSW(true);
    if (onKiosk || staffScreen) markUpdateReady(); else void updateSW(true);
  },
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    setRegistration(reg);
    // A kiosk checks every ten minutes; a till every fifteen, and whenever it comes back to the foreground.
    window.setInterval(() => void checkForUpdate(), (onKiosk ? 10 : 15) * 60_000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void checkForUpdate(); });
  },
});
setUpdater(updateSW);
// To see the update notice on a device without waiting for a real update: open any staff page with ?preview=update on its address.
if (staffScreen && new URLSearchParams(location.search).get("preview") === "update") markUpdateReady();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <TrainingBanner />
    {staffScreen && !onKiosk && <UpdateBar />}
  </StrictMode>,
);
