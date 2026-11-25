import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createStaff } from "../src/auth.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

describe("till settings and menu layouts", () => {
  let db: Db;
  let stop: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let base = "";
  let till = "";
  let ip = 0;
  const call = async (url: string, o: { body?: unknown; bearer?: string; method?: string } = {}) => {
    const res = await fetch(base + url, {
      method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
      headers: { "x-forwarded-for": `203.0.113.${++ip % 250}`, "x-device-token": till, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}) },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json };
  };
  beforeAll(async () => {
    ({ db, stop } = await startTestDb());
    const cat = new PgCatalogStore(db, "bp");
    await cat.ensureSeeded(seedCatalog());
    app = await buildApp({ config: PRESETS.fastServe("bp", "Bailey & Patch", "EV"), db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null });
    till = (await enroll(db, "bp", c.code, "Till"))!.token;
    await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat Cashier", role: "cashier", pin: "3333" });
    await createStaff(db, { merchantId: "bp", code: "M1", name: "Max Manager", role: "manager", pin: "222222" });
  }, 120_000);
  afterAll(async () => { await app?.close(); await stop?.(); });

  const page = (name: string, cells: any[] = []) => ({ name, cells: [...cells, ...Array(25 - cells.length).fill(null)] });
  it("Cancel, Hold and Send can sit on the menu grid as tiles; an unknown action is refused", async () => {
    const m = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    const ok = await call("/api/settings/till", { bearer: m, method: "PUT", body: { layout: { pages: [page("TOP MENU", [{ k: "fn", id: "send" }, { k: "fn", id: "hold" }, { k: "fn", id: "cancel" }])] } } });
    expect(ok.status).toBe(200);
    expect(ok.json.layout.pages[0].cells.slice(0, 3)).toEqual([{ k: "fn", id: "send" }, { k: "fn", id: "hold" }, { k: "fn", id: "cancel" }]);
    expect((await call("/api/settings/till", { bearer: m, method: "PUT", body: { layout: { pages: [page("TOP MENU", [{ k: "fn", id: "refund" }])] } } })).status).toBe(400);
    await call("/api/settings/till", { bearer: m, method: "PUT", body: { layout: null } });
  });
  it("a manager chooses whether sliding a line removes it at once; the default is a bin button, and nonsense is refused", async () => {
    const m = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    expect((await call("/api/settings/till", { bearer: m })).json.lineRemove).toBe("bin");
    expect((await call("/api/settings/till", { bearer: m, method: "PUT", body: { lineRemove: "swipe" } })).json.lineRemove).toBe("swipe");
    expect((await call("/api/settings/till", { bearer: m })).json.lineRemove).toBe("swipe");
    expect((await call("/api/settings/till", { bearer: m, method: "PUT", body: { lineRemove: "explode" } })).status).toBe(400);
    await call("/api/settings/till", { bearer: m, method: "PUT", body: { lineRemove: "bin" } });
  });
  it("a manager sets the shop's actions, payment options, dashboard and standard layout; anyone reads them", async () => {
    const c = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
    const m = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    expect((await call("/api/settings/till", { bearer: c })).json).toMatchObject({ dashboard: true, layout: null, actions: { order: [], hidden: [] } });
    expect((await call("/api/settings/till", { bearer: c, method: "PUT", body: { dashboard: false } })).status).toBe(403);
    const put = await call("/api/settings/till", { bearer: m, method: "PUT", body: { actions: { order: ["send", "hold"], hidden: ["drawer"] }, tenders: { order: ["credit", "cash"], hidden: [] }, dashboard: false, layout: { pages: [page("TOP MENU", [{ k: "item", id: "nasi-lemak" }, { k: "discount" }])] } } });
    expect(put.status).toBe(200);
    expect((await call("/api/settings/till", { bearer: c })).json).toMatchObject({ dashboard: false, actions: { order: ["send", "hold"], hidden: ["drawer"] }, tenders: { order: ["credit", "cash"] }, layout: { pages: [{ name: "TOP MENU" }] } });
    // a layout with the wrong number of cells, or an odd cell, is refused and nothing changes
    expect((await call("/api/settings/till", { bearer: m, method: "PUT", body: { layout: { pages: [{ name: "x", cells: [null] }] } } })).status).toBe(400);
    expect((await call("/api/settings/till", { bearer: m, method: "PUT", body: { actions: { order: ["bad id!"], hidden: [] } } })).status).toBe(400);
    expect((await call("/api/settings/till", { bearer: c })).json.dashboard).toBe(false);
    expect((await call("/api/settings/till", { bearer: m, method: "PUT", body: { layout: null } })).json.layout).toBeNull();
  });

  it("a person keeps their own layout, others do not see it, and clearing it brings the shop's back", async () => {
    const a = (await call("/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
    const m = (await call("/api/auth/login", { body: { code: "M1", pin: "222222" } })).json.token;
    const mine = { pages: [page("Mine", [{ k: "category", name: "Drinks" }])] };
    expect((await call("/api/auth/prefs", { bearer: a, method: "PUT", body: { layout: mine } })).json.prefs.layout.pages[0].name).toBe("Mine");
    expect((await call("/api/auth/prefs", { bearer: a, method: "PUT", body: { layout: { pages: [] } } })).status).toBe(400);
    expect((await call("/api/auth/prefs", { bearer: m })).json.prefs.layout).toBeUndefined();
    expect((await call("/api/auth/prefs", { bearer: a })).json.prefs.layout.pages[0].cells[0]).toEqual({ k: "category", name: "Drinks" });
    expect((await call("/api/auth/prefs", { bearer: a, method: "PUT", body: { layout: null } })).json.prefs.layout).toBeUndefined();
  });
});
