import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// The kiosk QR bridge: the kiosk shows a code, the customer's own phone signs in and confirms, the kiosk receives that member.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;

async function call(method: string, url: string, o: { body?: object; token?: string } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "x-forwarded-for": `192.0.2.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  process.env.SHOP_OPEN_SIGNIN = "1"; // the quickest way to give the "phone" a signed-in member
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  delete process.env.SHOP_OPEN_SIGNIN;
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("kiosk pairing", () => {
  it("hands the phone's member to the kiosk, once", async () => {
    const start = await call("POST", "/api/shop/auth/kiosk/start");
    expect(start.status).toBe(200);
    expect(start.json.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(start.json.url).toContain(`/pair?code=${start.json.code}`);
    expect(start.json.expiresInSeconds).toBe(300);

    expect((await call("GET", `/api/shop/auth/kiosk/${start.json.id}`)).json.state).toBe("waiting");

    const phone = await call("POST", "/api/shop/auth/phone/open", { body: { phone: "+65 9123 4567" } });
    expect(phone.status).toBe(200);
    // The code is typed in lower case with a space: still accepted.
    const attach = await call("POST", "/api/shop/auth/kiosk/attach", { token: phone.json.token, body: { code: start.json.code.toLowerCase().replace(/^(...)/, "$1 ") } });
    expect(attach.status).toBe(200);

    const got = await call("GET", `/api/shop/auth/kiosk/${start.json.id}`);
    expect(got.json.state).toBe("attached");
    expect(got.json.member.id).toBe(phone.json.member.id);
    // The kiosk gets its OWN session, not a copy of the phone's token.
    expect(got.json.token).toBeTruthy();
    expect(got.json.token).not.toBe(phone.json.token);
    expect((await call("GET", "/api/shop/me", { token: got.json.token })).json.member.id).toBe(phone.json.member.id);

    // Single use: the pairing is gone.
    expect((await call("GET", `/api/shop/auth/kiosk/${start.json.id}`)).json.state).toBe("expired");
  });

  it("refuses a phone that is not signed in, a wrong code, and a code used twice", async () => {
    const start = await call("POST", "/api/shop/auth/kiosk/start");
    expect((await call("POST", "/api/shop/auth/kiosk/attach", { body: { code: start.json.code } })).status).toBe(401);
    const phone = await call("POST", "/api/shop/auth/phone/open", { body: { phone: "+65 9123 4567" } });
    expect((await call("POST", "/api/shop/auth/kiosk/attach", { token: phone.json.token, body: { code: "AAAAAA" } })).status).toBe(404);
    expect((await call("POST", "/api/shop/auth/kiosk/attach", { token: phone.json.token, body: {} })).status).toBe(404);
    expect((await call("POST", "/api/shop/auth/kiosk/attach", { token: phone.json.token, body: { code: start.json.code } })).status).toBe(200);
    const other = await call("POST", "/api/shop/auth/phone/open", { body: { phone: "+65 8888 0000" } });
    expect((await call("POST", "/api/shop/auth/kiosk/attach", { token: other.json.token, body: { code: start.json.code } })).status).toBe(409);
  });

  it("an unknown pairing id reads as expired", async () => {
    expect((await call("GET", "/api/shop/auth/kiosk/not-a-real-id")).json.state).toBe("expired");
  });
});
