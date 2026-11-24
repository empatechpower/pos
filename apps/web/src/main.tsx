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
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() { if (onKiosk || staffScreen) markUpdateReady(); else void updateSW(true); },
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    setRegistration(reg);
    // A kiosk checks every ten minutes; a till every fifteen, and whenever it comes back to the foreground.
    window.setInterval(() => void checkForUpdate(), (onKiosk ? 10 : 15) * 60_000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void checkForUpdate(); });
  },
});
setUpdater(updateSW);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <TrainingBanner />
    {staffScreen && !onKiosk && <UpdateBar />}
  </StrictMode>,
);
