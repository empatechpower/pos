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
        // Chrome only offers "Install" when the manifest has real icons (192 and 512 px); with none, it offers a shortcut only.
        id: "/",
        name: "Bailey & Patch",
        short_name: "Bailey & Patch",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#FFFEFB",
        theme_color: "#EA7016",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: { navigateFallback: "/index.html", navigateFallbackDenylist: [/^\/hub\.mjs$/, /\.apk$/, /^\/api\//, /^\/about(\/|$)/], globPatterns: ["**/*.{js,css,html,svg,png,woff2}"] },
    }),
  ],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
});
