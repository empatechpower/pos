import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { TrainingBanner } from "./views/TrainingBanner";
import { adoptLegacyHash, installLinkHandler } from "./nav";
import { markUpdateReady, setUpdater } from "./pwaUpdate";
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
const updateSW = registerSW({
  immediate: true,
  // A new version waits here. Everywhere but the kiosk it is taken at once; the kiosk holds it for a quiet start screen.
  onNeedRefresh() { if (onKiosk) markUpdateReady(); else void updateSW(true); },
  // A kiosk is never reloaded by a visit, so it asks for a new version itself every ten minutes.
  onRegisteredSW(_url, reg) { if (onKiosk && reg) window.setInterval(() => void reg.update().catch(() => undefined), 10 * 60_000); },
});
setUpdater(updateSW);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
    <TrainingBanner />
  </StrictMode>,
);
