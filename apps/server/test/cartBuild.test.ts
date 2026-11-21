import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

// Backend handout sections 5, 8, 9 and fixtures 6, 7, 10: build pricing, the outlet-keyed server cart, edit-from-cart, a flagged sold-out option, and the frozen build.

let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let ip = 0;
let device = "";
let owner = "";
let evMgr = "";
const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");

async function call(url: string, o: { method?: string; body?: unknown; staff?: string } = {}) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(device ? { "x-device-token": device } : {}), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const login = async (code: string, pin: string) => (await call("/api/auth/login", { body: { code, pin } })).json.token as string;
const bowl = {
  groups: [
    { id: "protein", name: "Protein", minSelect: 1, maxSelect: 1, allowance: { mode: "dollar", value: 450 }, options: [{ id: "salmon", name: "Salmon", priceCents: 750 }, { id: "chicken", name: "Chicken", priceCents: 450 }] },
    { id: "supp", name: "Supplements", minSelect: 1, maxSelect: 6, options: [{ id: "broc", name: "Broccoli", priceCents: 150 }] },
  ],
};
let bowlId = "";
let teaId = "";

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Till"))!.token;
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olive", role: "owner", pin: "999999" });
  await createStaff(db, { merchantId: "bp", code: "EVM", name: "Eve", role: "manager", pin: "222222", outletId: "EV" });
  owner = await login("OWN", "999999");
  evMgr = await login("EVM", "222222");
  expect((await call("/api/outlets/CBD", { method: "PUT", body: { name: "CBD shop", serviceMode: "qsr" }, staff: owner })).status).toBe(200);
  expect((await call("/api/outlets/EV", { method: "PUT", body: { name: "Enabling Village", serviceMode: "qsr" }, staff: owner })).status).toBe(200);
  const tea = await call("/api/catalog/products", { body: { name: "Menu Tea", category: "Drinks", priceCents: 250 }, staff: owner });
  expect(tea.status).toBe(200);
  const b = await call("/api/catalog/products", { body: { name: "Menu Bowl", category: "Bowls", priceCents: 1350, builder: bowl }, staff: owner });
  expect(b.status).toBe(200);
  const products = (await call("/api/catalog")).json.products as any[];
  teaId = products.find((p) => p.name === "Menu Tea").id;
  bowlId = products.find((p) => p.name === "Menu Bowl").id;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});


const KEY = "cart-key-aaaaaaaa";
const cart = (o: { method?: string; url?: string; body?: unknown; key?: string } = {}) => callK(o.url ?? "/api/shop/cart", o);
async function callK(url: string, o: { method?: string; body?: unknown; key?: string }) {
  const res = await fetch(base + url, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, "x-cart-key": o.key ?? KEY, ...(o.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const salmonBuild = { picks: [{ groupId: "protein", optionId: "salmon" }, { groupId: "supp", optionId: "broc" }] };
const chickenBuild = { picks: [{ groupId: "protein", optionId: "chicken" }, { groupId: "supp", optionId: "broc" }] };

describe("build pricing, cart and the frozen build", () => {
  it("prices a build with the split per selection, and says what is missing in an invalid one", async () => {
    const ok = (await call("/api/shop/build/price", { body: { outletId: "EV", productId: bowlId, build: salmonBuild } })).json;
    expect(ok.ok).toBe(true);
    expect(ok.unitCents).toBe(1800);
    expect(ok.selections[0]).toMatchObject({ optionId: "salmon", fullCents: 750, coveredCents: 450, chargedCents: 300 });
    const bad = (await call("/api/shop/build/price", { body: { outletId: "EV", productId: bowlId, build: { picks: [{ groupId: "protein", optionId: "salmon" }] } } })).json;
    expect(bad.ok).toBe(false);
    expect(bad.validation.groups.find((g: any) => g.groupId === "supp").state).toBe("below_min");
  });

  it("needs a cart key, refuses an invalid build, adds, and merges identical lines", async () => {
    expect((await call("/api/shop/cart")).status).toBe(400);
    expect((await cart({ url: "/api/shop/cart/lines", body: { outletId: "EV", productId: bowlId } })).json.error).toBe("build_invalid");
    const a = await cart({ url: "/api/shop/cart/lines", body: { outletId: "EV", productId: bowlId, build: salmonBuild } });
    expect(a.status).toBe(200);
    expect(a.json.lines.length).toBe(1);
    expect(a.json.totals.total).toBe(1800);
    const again = await cart({ url: "/api/shop/cart/lines", body: { outletId: "EV", productId: bowlId, build: salmonBuild } });
    expect(again.json.lines.length).toBe(1);
    expect(again.json.lines[0].qty).toBe(2);
    expect(again.json.totals.total).toBe(3600);
    await cart({ method: "PUT", url: `/api/shop/cart/lines/${again.json.lines[0].lineId}`, body: { outletId: "EV", qty: 1 } });
  });

  it("edit from the cart: the same line, new build, new totals, no duplicate (fixture 7)", async () => {
    const before = (await cart({ url: "/api/shop/cart?outlet=EV" })).json;
    const id = before.lines[0].lineId;
    const r = await cart({ method: "PUT", url: `/api/shop/cart/lines/${id}`, body: { outletId: "EV", build: chickenBuild } });
    expect(r.status).toBe(200);
    expect(r.json.lines.length).toBe(1);
    expect(r.json.lines[0].lineId).toBe(id);
    expect(r.json.totals.total).toBe(1500);
    const bad = await cart({ method: "PUT", url: `/api/shop/cart/lines/${id}`, body: { outletId: "EV", build: { picks: [] } } });
    expect(bad.status).toBe(400);
    expect((await cart({ url: "/api/shop/cart?outlet=EV" })).json.totals.total).toBe(1500); // a refused edit leaves the line as it was
    await cart({ method: "PUT", url: `/api/shop/cart/lines/${id}`, body: { outletId: "EV", build: salmonBuild } });
  });

  it("switching outlet never destroys the other cart (fixture 10)", async () => {
    const cbd = await cart({ url: "/api/shop/cart/lines", body: { outletId: "CBD", productId: bowlId, build: chickenBuild } });
    expect(cbd.json.lines.length).toBe(1);
    expect(cbd.json.otherCarts).toEqual([{ outletId: "EV", lineCount: 1 }]);
    const ev = (await cart({ url: "/api/shop/cart?outlet=EV" })).json;
    expect(ev.lines.length).toBe(1);
    const all = (await cart({ url: "/api/shop/carts" })).json.carts.map((c: any) => c.outletId).sort();
    expect(all).toEqual(["CBD", "EV"]);
    // another customer's cart is separate
    expect((await cart({ url: "/api/shop/cart?outlet=EV", key: "someone-else-bbbbbb" })).json.lines.length).toBe(0);
  });

  it("an option that sells out is flagged in the cart, with the stored build unchanged (fixture 6)", async () => {
    expect((await call("/api/outlets/EV/menu/" + bowlId, { method: "PUT", body: { soldOutOptions: ["salmon"] }, staff: owner })).status).toBe(200);
    const c = (await cart({ url: "/api/shop/cart?outlet=EV" })).json;
    expect(c.flagged).toBe(1);
    expect(c.lines[0].state).toBe("build_invalid");
    expect(c.lines[0].validation.groups.find((g: any) => g.groupId === "protein").state).toBe("unavailable_option");
    expect(c.lines[0].build.picks[0].optionId).toBe("salmon"); // not silently changed or removed
    expect((await call("/api/outlets/EV/menu/" + bowlId, { method: "PUT", body: { soldOutOptions: [] }, staff: owner })).status).toBe(200);
    expect((await cart({ url: "/api/shop/cart?outlet=EV" })).json.flagged).toBe(0);
  });

  it("order submission freezes the structured build with each selection's allocation", async () => {
    const r = await callK("/api/shop/orders", { body: { channelId: "take-away", outletId: "EV", items: [{ productId: bowlId, qty: 1, build: salmonBuild }], customerName: "T", customerPhone: "" } });
    expect(r.status).toBe(200);
    expect((await cart({ url: "/api/shop/cart?outlet=EV" })).json.lines.length).toBe(0); // the placed order emptied this outlet's cart
    expect((await cart({ url: "/api/shop/cart?outlet=CBD" })).json.lines.length).toBe(1); // the other outlet's cart stays
    expect(r.json.totalCents).toBe(1800);
    const ev = (await db.query("SELECT body FROM events WHERE merchant_id='bp' AND order_id=$1 AND type='ItemAdded'", [r.json.orderId])).rows[0].body;
    expect(ev.build.selections.map((s: any) => [s.optionId, s.fullCents, s.coveredCents, s.chargedCents])).toEqual([["salmon", 750, 450, 300], ["broc", 150, 0, 150]]);
    const st = (await call(`/api/shop/orders/${r.json.orderId}`)).json;
    expect(st.items[0].options.join(" ")).toContain("Salmon");
    expect(typeof st.menuVersion).toBe("number");
    expect(st.menuState.state).toBe("ORDERABLE");
    const bad = await call("/api/shop/orders", { body: { channelId: "take-away", outletId: "EV", items: [{ productId: bowlId, qty: 1 }], customerName: "T", customerPhone: "" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("build_invalid");
  });
});
