import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { adoptLegacyHash, installLinkHandler } from "./nav";
import "./styles.css";

adoptLegacyHash();
// The kiosk installs as its own app that opens on /kiosk; everything else installs from the default manifest.
if (location.pathname === "/kiosk" || location.pathname.startsWith("/kiosk/")) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]') ?? document.head.appendChild(Object.assign(document.createElement("link"), { rel: "manifest" }));
  link.href = "/manifest-kiosk.webmanifest";
}
installLinkHandler();
registerSW({ immediate: true });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
