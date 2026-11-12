import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Precaches the app shell so the POS opens with no network at all.
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "POS",
        short_name: "POS",
        start_url: "/",
        display: "standalone",
        background_color: "#FFFEFB",
        theme_color: "#EA7016",
        icons: [],
      },
      workbox: { navigateFallback: "/index.html", navigateFallbackDenylist: [/^\/hub\.mjs$/, /^\/api\//], globPatterns: ["**/*.{js,css,html,svg,png,woff2}"] },
    }),
  ],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
});
