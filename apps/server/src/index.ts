import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { PRESETS } from "@pos/core";
import { buildApp } from "./app.js";
import { PgCatalogStore, StaticCatalogStore } from "./catalog.js";
import { BrandStore } from "./brand.js";
import { loadIntegrations } from "./integrations.js";
import { setupTelegramWebhook } from "./telegram.js";
import { seedCatalog } from "./catalogSeed.js";
import { loadBaileyPatch } from "./seed.js";
import { PrintStore } from "./print.js";
import { createPool, migrate } from "./db/pool.js";
import { PgEventStore } from "./pgStore.js";
import { JsonFileEventStore, type EventStore } from "./store.js";

const dataFile = fileURLToPath(new URL("../data/events.json", import.meta.url));

// Which mode this deployment runs in. Change via POS_MODE=restaurant|delivery|fastServe.
const mode = (process.env.POS_MODE ?? "fastServe") as keyof typeof PRESETS;
const config = PRESETS[mode]("bailey-patch", "Bailey & Patch", "Enabling Village");
// Rewards (points, coupons, stamps, welcome gifts) are off unless REWARDS=on. Members and prepaid credit work either way.
if (process.env.REWARDS !== "on") config.rewards = { ...config.rewards, pointsEnabled: false, welcomePoints: 0, welcomeVoucherCents: 0, stampCard: { ...config.rewards.stampCard, enabled: false } };

// Postgres when DATABASE_URL is set; otherwise the JSON file, so local development needs nothing.
const db = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : null;
if (db) await migrate(db);
const store: EventStore = db ? new PgEventStore(db, config.businessId, config.outletName) : new JsonFileEventStore(dataFile);

const pgCatalog = db ? new PgCatalogStore(db, config.businessId) : null;
// A brand-new database starts with the Bailey & Patch menu from the prototype (SEED=sample for a tiny demo menu).
const bp = process.env.SEED === "sample" ? null : loadBaileyPatch();
if (pgCatalog && db) {
  await pgCatalog.ensureSeeded(bp?.catalog ?? seedCatalog(), bp?.images);
  if (bp) await new BrandStore(db, config.businessId).seedIfEmpty(bp.brand);
}

const app = await buildApp({ config, store, db, catalog: pgCatalog ?? new StaticCatalogStore(seedCatalog()), catalogAdmin: pgCatalog ?? undefined, print: db ? new PrintStore(db, config.businessId) : undefined, trustProxy: process.env.TRUST_PROXY === "1", integrations: loadIntegrations(process.env) });
// In production one service serves both the API and the built web app (same address, so sign-in redirects and
// payment webhooks all land in one place). Skipped in development, where Vite serves the web app.
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
if (existsSync(webDist)) {
  // Hashed assets never change; the shell and service worker must always be re-checked.
  await app.register(fastifyStatic, {
    root: webDist,
    wildcard: false,
    cacheControl: false,
    setHeaders: (res, path) => res.setHeader("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache"),
  });
  // The Rezein landing page (one static page) lives at /about/ on the same address.
  const landingDir = fileURLToPath(new URL("../../landing", import.meta.url));
  if (existsSync(landingDir)) {
    await app.register(fastifyStatic, { root: landingDir, prefix: "/about/", decorateReply: false, cacheControl: false, setHeaders: (res) => res.setHeader("cache-control", "public, max-age=300") });
    app.get("/about", (_req, reply) => reply.redirect("/about/"));
  }
  app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "not found" }) : reply.header("cache-control", "no-cache").sendFile("index.html")));
}

await app.listen({ port: Number(process.env.PORT ?? 8787), host: "0.0.0.0" });
// If the Telegram bot is set up, tell Telegram where to send messages. Safe to repeat on every start.
if (db) void setupTelegramWebhook(loadIntegrations(process.env));
