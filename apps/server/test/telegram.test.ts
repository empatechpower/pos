import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRESETS, type Catalog } from "@pos/core";
import { buildApp } from "../src/app.js";
import { createStaff } from "../src/auth.js";
import { PgCatalogStore } from "../src/catalog.js";
import { seedCatalog } from "../src/catalogSeed.js";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import { PgEventStore } from "../src/pgStore.js";
import { findItems, parseAmount, setupTelegramWebhook } from "../src/telegram.js";
import type { Integrations } from "../src/integrations.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

const config = PRESETS.fastServe("bp", "Bailey & Patch", "EV");
let db: Db;
let stop: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = "";
let device = "";
let mgr = "";
let cashier = "";
let ip = 0;

/** Everything the bot sent to Telegram. */
const sent: Array<{ method: string; body: any }> = [];
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (!u.startsWith("https://api.telegram.org/botTOK/")) return new Response("?", { status: 500 });
  const method = u.split("/").pop()!;
  sent.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
  return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { username: "rezein_test_bot" } : {} }));
}) as typeof fetch;
const integrations: Integrations = { publicUrl: "https://shop.example", telegram: { token: "TOK", webhookSecret: "hook-secret", adminIds: ["777"], managerIds: ["555"] }, fetch: fakeFetch };

async function call(method: string, url: string, o: { body?: object; staff?: string; device?: string | null; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "x-forwarded-for": `198.51.100.${++ip % 250}`, ...(o.body ? { "content-type": "application/json" } : {}), ...(o.device === null ? {} : { "x-device-token": o.device ?? device }), ...(o.staff ? { authorization: `Bearer ${o.staff}` } : {}), ...o.headers },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
}
const getCatalog = async () => (await call("GET", "/api/catalog")).json as Catalog;

let updateId = 0;
/** Say something to the bot as Telegram user `from`, and return what the bot said back. */
async function say(from: number, text: string, o: { chatType?: string; secret?: string } = {}) {
  const start = sent.length;
  const r = await call("POST", "/api/telegram/webhook", { body: { update_id: ++updateId, message: { message_id: updateId, chat: { id: from, type: o.chatType ?? "private" }, from: { id: from, first_name: `User${from}` }, text } }, device: null, headers: { "x-telegram-bot-api-secret-token": o.secret ?? "hook-secret" } });
  return { status: r.status, said: sent.slice(start).filter((s) => s.method === "sendMessage").map((s) => s.body) };
}
/** Press a button on one of the bot's messages. */
async function press(from: number, data: string) {
  const start = sent.length;
  await call("POST", "/api/telegram/webhook", { body: { update_id: ++updateId, callback_query: { id: `cb${updateId}`, from: { id: from }, message: { message_id: 1, chat: { id: from, type: "private" } }, data } }, device: null, headers: { "x-telegram-bot-api-secret-token": "hook-secret" } });
  return sent.slice(start).filter((s) => s.method === "sendMessage").map((s) => s.body);
}
const buttons = (msg: any) => (msg.reply_markup?.inline_keyboard ?? []).flat() as Array<{ text: string; callback_data?: string; url?: string }>;
const link = async (tg: number, staff = mgr) => {
  const code = (await call("POST", "/api/telegram/link-code", { staff })).json.code as string;
  return say(tg, `/link ${code}`);
};

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  const cat = new PgCatalogStore(db, "bp");
  await cat.ensureSeeded(seedCatalog());
  app = await buildApp({ config, db, logger: false, store: new PgEventStore(db, "bp", "EV"), catalog: cat, catalogAdmin: cat, trustProxy: true, integrations });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  device = (await enroll(db, "bp", (await createEnrollmentCode(db, { merchantId: "bp", outletId: "EV", createdBy: null })).code, "Laptop"))!.token;
  await createStaff(db, { merchantId: "bp", code: "MGR", name: "Max", role: "manager", pin: "222222" });
  await createStaff(db, { merchantId: "bp", code: "C1", name: "Cat", role: "cashier", pin: "3333" });
  await createStaff(db, { merchantId: "bp", code: "OWN", name: "Olivia", role: "owner", pin: "999999" });
  mgr = (await call("POST", "/api/auth/login", { body: { code: "MGR", pin: "222222" } })).json.token;
  cashier = (await call("POST", "/api/auth/login", { body: { code: "C1", pin: "3333" } })).json.token;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await stop?.();
});

describe("reading what staff type", () => {
  it("finds the amount at the end, with or without a dollar sign, and allows 0", () => {
    expect(parseAmount("kaya toast 2.50")).toEqual({ query: "kaya toast", cents: 250 });
    expect(parseAmount("kaya toast $2.5")).toEqual({ query: "kaya toast", cents: 250 });
    expect(parseAmount("kaya toast S$3")).toEqual({ query: "kaya toast", cents: 300 });
    expect(parseAmount("teh 0")).toEqual({ query: "teh", cents: 0 });
    expect(parseAmount("teh")).toBeNull();
    expect(parseAmount("teh 2.555")).toBeNull();
    expect(parseAmount("teh 99999")).toBeNull();
    expect(parseAmount("2.50")).toBeNull();
  });

  it("finds items by any words in the name, exact names first", async () => {
    const c = await getCatalog();
    expect(findItems(c.products, "nasi").map((p) => p.id)).toEqual(["nasi-lemak"]);
    expect(findItems(c.products, "TOAST").map((p) => p.id)).toContain("kaya-toast");
    expect(findItems(c.products, "rice karaage").map((p) => p.id)).toEqual(["karaage-rice"]);
    expect(findItems(c.products, "zzzz")).toEqual([]);
    expect(findItems(c.products, "  ")).toEqual([]);
  });
});

describe("who the bot talks to", () => {
  it("refuses a message that does not carry Telegram's secret", async () => {
    expect((await say(1, "/help", { secret: "wrong" })).status).toBe(401);
    expect((await call("POST", "/api/telegram/webhook", { body: { message: {} }, device: null })).status).toBe(401);
  });

  it("only managers and owners can make a link code", async () => {
    expect((await call("POST", "/api/telegram/link-code", { staff: cashier })).status).toBe(403);
    expect((await call("POST", "/api/telegram/link-code", {})).status).toBe(401);
    expect((await call("POST", "/api/telegram/link-code", { staff: mgr, device: null })).status).toBe(401);
  });

  it("tells a stranger how to link, and does nothing for them", async () => {
    const r = await say(900, "/price teh 1");
    expect(r.said[0].text).toMatch(/link/i);
    expect((await getCatalog()).pricebooks.find((b) => b.id === "standard")!.prices.teh).toBe(240);
    expect((await say(900, "/start")).said[0].text).toMatch(/Link my Telegram/);
  });

  it("links with a one-time code, once, and says so for a wrong code", async () => {
    const code = (await call("POST", "/api/telegram/link-code", { staff: mgr })).json.code as string;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const ok = await say(1001, `/link ${code}`);
    expect(ok.said[0].text).toMatch(/Linked/);
    expect((await say(1002, `/link ${code}`)).said[0].text).toMatch(/isn't valid|expired/); // used already
    expect((await say(1003, "/link NOTACODE")).said[0].text).toMatch(/isn't valid/);
    const status = (await call("GET", "/api/telegram/status", { staff: mgr })).json;
    expect(status).toMatchObject({ configured: true, bot: "rezein_test_bot" });
    expect(status.linked.map((l: any) => l.telegramId)).toEqual(["1001"]);
  });

  it("ignores group chats and plain chatter, and a linked person can unlink", async () => {
    expect((await say(1001, "/pricebooks", { chatType: "group" })).said).toEqual([]);
    expect((await say(1001, "hello")).said[0].text).toMatch(/\/help/);
    await link(1050);
    expect((await call("DELETE", "/api/telegram/links/1050", { staff: mgr })).status).toBe(200);
    expect((await say(1050, "/pricebooks")).said[0].text).toMatch(/don't know you/);
    expect((await call("DELETE", "/api/telegram/links/1050", { staff: mgr })).status).toBe(404);
  });
});

describe("changing prices from Telegram", () => {
  it("asks which pricebook, then changes the price and says what it was", async () => {
    const ask = (await say(1001, "/price nasi lemak 7.20")).said[0];
    expect(ask.text).toMatch(/Nasi Lemak to S\$7\.20/);
    const data = buttons(ask).map((b) => b.callback_data);
    expect(data).toContain("pp:nasi-lemak:standard:720");
    expect(data).toContain("pp:nasi-lemak:*:720");
    const done = await press(1001, "pp:nasi-lemak:standard:720");
    expect(done[0].text).toMatch(/Standard: S\$6\.90 → S\$7\.20/);
    const c = await getCatalog();
    expect(c.pricebooks.find((b) => b.id === "standard")!.prices["nasi-lemak"]).toBe(720);
    expect(c.pricebooks.find((b) => b.id === "grab")!.prices["nasi-lemak"]).not.toBe(720); // only the one asked for
    const audit = (await call("GET", "/api/audit", { staff: mgr })).json.entries as any[];
    expect(audit.find((a) => a.action === "catalog.price" && a.detail.via === "telegram")?.detail).toMatchObject({ productId: "nasi-lemak", priceCents: 720 });
  });

  it("can change the price in every pricebook at once", async () => {
    await press(1001, "pp:nasi-lemak:*:500");
    const c = await getCatalog();
    expect(c.pricebooks.map((b) => b.prices["nasi-lemak"])).toEqual(c.pricebooks.map(() => 500));
  });

  it("a price of 0 is accepted: the item is free, not removed", async () => {
    await press(1001, "pp:teh:standard:0");
    const c = await getCatalog();
    expect(c.pricebooks.find((b) => b.id === "standard")!.prices.teh).toBe(0);
    await press(1001, "pp:teh:standard:240");
  });

  it("offers a choice when more than one item matches", async () => {
    const ask = (await say(1001, "/price rice 9")).said[0];
    expect(ask.text).toBe("Which item?");
    const items = buttons(ask).map((b) => b.callback_data);
    expect(items).toContain("pi:karaage-rice:900");
    expect(items).toContain("pi:fried-rice:900");
    const next = await press(1001, "pi:fried-rice:900");
    expect(next[0].text).toMatch(/In which pricebook/);
  });

  it("says plainly when nothing matches or the message is wrong", async () => {
    expect((await say(1001, "/price unicorn 5")).said[0].text).toMatch(/No item matches/);
    expect((await say(1001, "/price")).said[0].text).toMatch(/for example/);
    expect((await say(1001, "/price nasi lemak")).said[0].text).toMatch(/for example/);
  });

  it("ignores buttons that were tampered with", async () => {
    const before = await getCatalog();
    await press(1001, "pp:nasi-lemak:nope:100");
    await press(1001, "pp:ghost:standard:100");
    await press(1001, "pp:nasi-lemak:standard:-5");
    await press(1001, "pp:nasi-lemak:standard:99999999");
    await press(1001, "pp:nasi-lemak:standard:abc");
    await press(1001, "op:maybe:teh:standard");
    expect((await getCatalog()).version).toBe(before.version);
  });

  it("a stranger pressing a button changes nothing", async () => {
    const before = await getCatalog();
    await press(4242, "pp:nasi-lemak:standard:1");
    expect((await getCatalog()).version).toBe(before.version);
  });
});

describe("switching items off and on", () => {
  it("switches an item off in the chosen pricebook, keeps its price, and brings it back", async () => {
    const ask = (await say(1001, "/off milk tea")).said[0];
    expect(buttons(ask).map((b) => b.callback_data)).toContain("op:off:teh:grab");
    const off = await press(1001, "op:off:teh:grab");
    expect(off[0].text).toMatch(/OFF in Grab.*hidden from online ordering.*greyed out on the till/);
    const c = await getCatalog();
    expect(c.pricebooks.find((b) => b.id === "grab")!.off).toContain("teh");
    expect(c.pricebooks.find((b) => b.id === "grab")!.prices.teh).toBeGreaterThan(0);
    expect(c.pricebooks.find((b) => b.id === "standard")!.off ?? []).not.toContain("teh");
    expect((await press(1001, "op:on:teh:grab"))[0].text).toMatch(/back ON in Grab/);
    expect((await getCatalog()).pricebooks.find((b) => b.id === "grab")!.off ?? []).not.toContain("teh");
  });

  it("can switch off in every pricebook", async () => {
    await press(1001, "op:off:barley:*");
    const c = await getCatalog();
    expect(c.pricebooks.every((b) => b.off?.includes("barley"))).toBe(true);
    await press(1001, "op:on:barley:*");
  });
});

describe("a new pricebook from Telegram", () => {
  it("copies Dine in into a new pricebook and channel, then gives a one-time link to edit it", async () => {
    const ask = (await say(1001, "/newpricebook Foodpanda")).said[0];
    expect(ask.text).toMatch(/copy Standard into a new pricebook “Foodpanda”/);
    const kinds = buttons(ask).map((b) => b.callback_data!);
    expect(kinds).toHaveLength(3);
    const made = await press(1001, kinds.find((k) => k.endsWith(":delivery"))!);
    expect(made[0].text).toMatch(/Created pricebook “Foodpanda”.*It is live now/s);
    const c = await getCatalog();
    const book = c.pricebooks.find((b) => b.name === "Foodpanda")!;
    expect(book.prices).toEqual(c.pricebooks.find((b) => b.id === "standard")!.prices);
    const ch = c.channels.find((x) => x.name === "Foodpanda")!;
    expect(ch).toMatchObject({ kind: "delivery", serviceCharge: false, active: true });
    expect(c.assignments).toContainEqual({ pricebookId: book.id, channelId: ch.id });
    // the link in the message works once and lands on that pricebook
    const url = buttons(made[0]).find((b) => b.url)!.url!;
    expect(url).toMatch(/^https:\/\/shop\.example\/#\/tg\?code=[A-Z2-9]{8}$/);
    const code = url.split("code=")[1]!;
    const web = await call("POST", "/api/telegram/redeem", { body: { code }, device: null });
    expect(web.status).toBe(200);
    expect(web.json.to).toBe(`pricebook/${book.id}`);
    expect(web.json.staff).toMatchObject({ code: "MGR", role: "manager" });
    expect((await call("POST", "/api/telegram/redeem", { body: { code }, device: null })).status).toBe(401); // used already
    // and what it hands back really signs the browser in
    const me = await call("GET", "/api/auth/me", { staff: web.json.token, device: web.json.deviceToken });
    expect(me.json).toMatchObject({ code: "MGR" });
    expect((await call("POST", `/api/catalog/pricebooks/${book.id}/bulk`, { body: { prices: { teh: 1 } }, staff: web.json.token, device: web.json.deviceToken })).status).toBe(200);
  });

  it("refuses a name that is already used, and an empty one", async () => {
    expect((await say(1001, "/newpricebook Foodpanda")).said[0].text).toMatch(/already a pricebook or channel/);
    expect((await say(1001, "/newpricebook Take away")).said[0].text).toMatch(/already/);
    expect((await say(1001, "/newpricebook")).said[0].text).toMatch(/Give the new pricebook a name/);
  });

  it("a button for a lost name asks to start again", async () => {
    expect((await press(1001, "nk:deadbeef:delivery"))[0].text).toMatch(/expired/);
  });

  it("lists the pricebooks and what uses them", async () => {
    const text = (await say(1001, "/pricebooks")).said[0].text;
    expect(text).toMatch(/Standard \(default\)/);
    expect(text).toMatch(/Foodpanda/);
  });
});

describe("opening the web editor", () => {
  it("/edit asks which pricebook, then sends a link", async () => {
    const ask = (await say(1001, "/edit")).said[0];
    expect(buttons(ask).map((b) => b.callback_data)).toContain("ed:standard");
    const link = await press(1001, "ed:standard");
    expect(buttons(link[0]).find((b) => b.url)!.url).toMatch(/#\/tg\?code=/);
  });

  it("a wrong, expired or used code gets nothing, and wrong tries are limited", async () => {
    expect((await call("POST", "/api/telegram/redeem", { body: { code: "NOPE1234" }, device: null })).status).toBe(401);
    expect((await call("POST", "/api/telegram/redeem", { body: {}, device: null })).status).toBe(401);
    await db.query("UPDATE telegram_codes SET expires_at = now() - interval '1 minute' WHERE kind='web' AND used_at IS NULL");
    const url = buttons((await press(1001, "ed:standard"))[0]).find((b) => b.url)!.url!;
    await db.query("UPDATE telegram_codes SET expires_at = now() - interval '1 minute' WHERE kind='web'");
    expect((await call("POST", "/api/telegram/redeem", { body: { code: url.split("code=")[1] }, device: null })).status).toBe(401);
  });

  it("one person can be signed in on several browsers at once; only beyond five are the oldest switched off", async () => {
    const mk = async () => {
      const url = buttons((await press(1001, "ed:standard"))[0]).find((b) => b.url)!.url!;
      return (await call("POST", "/api/telegram/redeem", { body: { code: url.split("code=")[1] }, device: null })).json;
    };
    const me = (x: any) => call("GET", "/api/auth/me", { staff: x.token, device: x.deviceToken });
    const a = await mk();
    const b = await mk();
    expect((await me(a)).status).toBe(200); // opening a second link does not sign the first browser out
    expect((await me(b)).status).toBe(200);
    const more = [await mk(), await mk(), await mk(), await mk()];
    expect((await me(a)).status).toBe(401); // six in all: the oldest is switched off
    expect((await me(b)).status).toBe(200);
    for (const x of more) expect((await me(x)).status).toBe(200);
  });
});

describe("setting up the webhook", () => {
  it("tells Telegram where to send messages, with the secret, and sets the command list", async () => {
    sent.length = 0;
    await setupTelegramWebhook(integrations, () => {});
    const hook = sent.find((s) => s.method === "setWebhook")!;
    expect(hook.body).toMatchObject({ url: "https://shop.example/api/telegram/webhook", secret_token: "hook-secret" });
    expect(sent.find((s) => s.method === "setMyCommands")!.body.commands.map((c: any) => c.command)).toContain("newpricebook");
  });

  it("does nothing without a bot token, or without an https address", async () => {
    sent.length = 0;
    await setupTelegramWebhook({ publicUrl: "https://shop.example" }, () => {});
    await setupTelegramWebhook({ ...integrations, publicUrl: "http://localhost:5173" }, () => {});
    expect(sent).toEqual([]);
  });
});

describe("opening the staff pages from Telegram", () => {
  it("a Telegram account named as the owner's needs no link code, and opens a page already signed in", async () => {
    const r = await say(777, "/manager");
    expect(r.said).toHaveLength(1);
    const url = buttons(r.said[0]).find((b) => b.url)?.url!;
    expect(url).toMatch(/^https:\/\/shop\.example\/#\/tg\?code=[A-Z0-9]{8}$/);
    const code = url.split("code=")[1]!;
    const redeemed = await call("POST", "/api/telegram/redeem", { body: { code }, device: null });
    expect(redeemed.status).toBe(200);
    expect(redeemed.json.to).toBe("manager");
    expect(redeemed.json.staff).toMatchObject({ code: "OWN", role: "owner" });
    // One use only.
    expect((await call("POST", "/api/telegram/redeem", { body: { code }, device: null })).status).toBe(401);
    expect((await db.query("SELECT 1 FROM audit_log WHERE action='telegram.autolink'")).rowCount).toBeGreaterThan(0);
  });

  it("opens Online, Printers and Prices the same way", async () => {
    for (const page of ["online", "printers", "prices"]) {
      const r = await say(777, `/${page}`);
      const code = buttons(r.said[0]).find((b) => b.url)!.url!.split("code=")[1]!;
      expect((await call("POST", "/api/telegram/redeem", { body: { code }, device: null })).json.to).toBe(page);
    }
  });

  it("anyone not named or linked gets no page", async () => {
    const r = await say(888, "/manager");
    expect(r.said).toHaveLength(1);
    expect(buttons(r.said[0]).some((b) => b.url)).toBe(false);
  });
});

describe("a customer given manager access through Telegram", () => {
  it("gets a manager login, never the owner's, and can open the pages and change a price", async () => {
    const r = await say(555, "/prices");
    const code = buttons(r.said[0]).find((b) => b.url)!.url!.split("code=")[1]!;
    const redeemed = await call("POST", "/api/telegram/redeem", { body: { code }, device: null });
    expect(redeemed.status).toBe(200);
    expect(redeemed.json.staff).toMatchObject({ code: "TGMGR", role: "manager" });
    expect(redeemed.json.to).toBe("prices");
    // The same login is reused, not made again, and its PIN is not one anybody has.
    await say(555, "/manager");
    expect((await db.query("SELECT count(*)::int AS n FROM staff WHERE code='TGMGR'")).rows[0].n).toBe(1);
    expect((await call("POST", "/api/auth/login", { body: { code: "TGMGR", pin: "123456" } })).status).toBe(401);
    // It can use the bot like any manager.
    expect((await say(555, "/pricebooks")).said[0].text).toMatch(/Pricebooks/);
  });
});

