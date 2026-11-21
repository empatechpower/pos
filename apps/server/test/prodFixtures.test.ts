import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

/** Test conveniences (a typed-in stand-in for the text message, codes echoed in responses) exist only outside production builds. */
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  } finally { process.env.NODE_ENV = was; }
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}, 120_000);
afterAll(async () => { await app?.close(); await stop?.(); });

describe("a production build carries no test fixtures", () => {
  it("has no simulated text-message route and never echoes a sign-in code", async () => {
    const sim = await fetch(`${base}/api/shop/auth/phone/simulate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "91234567", code: "123456" }) });
    expect(sim.status).toBe(404);
    const start = await fetch(`${base}/api/shop/auth/email/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co" }) });
    expect(JSON.stringify(await start.json().catch(() => ({})))).not.toMatch(/devCode/);
  });
});
