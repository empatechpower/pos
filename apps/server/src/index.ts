import { fileURLToPath } from "node:url";
import { PRESETS } from "@pos/core";
import { buildApp } from "./app.js";
import { PgCatalogStore, StaticCatalogStore } from "./catalog.js";
import { seedCatalog } from "./catalogSeed.js";
import { PrintStore } from "./print.js";
import { createPool, migrate } from "./db/pool.js";
import { PgEventStore } from "./pgStore.js";
import { JsonFileEventStore, type EventStore } from "./store.js";

const dataFile = fileURLToPath(new URL("../data/events.json", import.meta.url));

// Which mode this deployment runs in. Change via POS_MODE=restaurant|delivery|fastServe.
const mode = (process.env.POS_MODE ?? "fastServe") as keyof typeof PRESETS;
const config = PRESETS[mode]("bailey-patch", "Bailey & Patch", "Enabling Village");

// Postgres when DATABASE_URL is set; otherwise the JSON file, so local development needs nothing.
const db = process.env.DATABASE_URL ? createPool(process.env.DATABASE_URL) : null;
if (db) await migrate(db);
const store: EventStore = db ? new PgEventStore(db, config.businessId, config.outletName) : new JsonFileEventStore(dataFile);

const pgCatalog = db ? new PgCatalogStore(db, config.businessId) : null;
await pgCatalog?.ensureSeeded(seedCatalog());

const app = await buildApp({ config, store, db, catalog: pgCatalog ?? new StaticCatalogStore(seedCatalog()), catalogAdmin: pgCatalog ?? undefined, print: db ? new PrintStore(db, config.businessId) : undefined });
await app.listen({ port: Number(process.env.PORT ?? 8787), host: "0.0.0.0" });
