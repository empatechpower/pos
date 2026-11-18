import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { adoptLegacyHash, installLinkHandler } from "./nav";
import "./styles.css";

adoptLegacyHash();
installLinkHandler();
registerSW({ immediate: true });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
