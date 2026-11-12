import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { formatMoney, type Catalog, type ChannelKind, type Product } from "@pos/core";
import { audit, can, startSessionFor, type Permission } from "./auth.js";
import type { PgCatalogStore } from "./catalog.js";
import type { Db } from "./db/pool.js";
import { createLinkedDevice } from "./devices.js";
import { sameSecret, type Integrations } from "./integrations.js";
import { FailureLimiter } from "./rateLimit.js";

/**
 * The shop's Telegram bot. Linked managers and owners tell it what to do in plain commands:
 *   /newpricebook Grab        copy "Dine in" into a new pricebook and a new channel of that name
 *   /price kaya toast 2.50    change one price (asks which pricebook)
 *   /off teh   /on teh        switch an item off or on in a pricebook (off = hidden online, greyed out on a till)
 *   /edit                     a one-time link to a web page that edits every item in a pricebook
 * Staff link their Telegram account with a one-time code made on the Manager page, so the bot never sees a PIN.
 */

type Button = { text: string; callback_data?: string; url?: string };
interface TgUser { id: number; first_name?: string; username?: string }
interface TgMessage { message_id: number; chat: { id: number; type: string }; from?: TgUser; text?: string }
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { message?: TgMessage; callback_query?: TgCallback }

export interface TelegramDeps {
  db: Db;
  merchantId: string;
  outletId: string;
  integ: Integrations;
  cat: PgCatalogStore;
  needs: (permission: Permission) => (req: FastifyRequest, reply: FastifyReply) => unknown;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
const LINK_MINUTES = 10;
const WEB_MINUTES = 10;
const MAX_CENTS = 1_000_000;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** "kaya toast 2.50", "kaya toast $2.5", "kaya toast S$0": the words, and the price in cents (0 is a real price). */
export function parseAmount(text: string): { query: string; cents: number } | null {
  const m = /^(.*\S)\s+(?:s?\$)?\s*(\d+(?:\.\d{1,2})?)$/i.exec(text.trim());
  if (!m) return null;
  const cents = Math.round(parseFloat(m[2]!) * 100);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_CENTS ? { query: m[1]!.trim(), cents } : null;
}

/** Items whose name (or other-language name) contains every word typed. An exact name match comes first. */
export function findItems(products: readonly Product[], query: string, limit = 8): Product[] {
  const words = norm(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  const hay = (p: Product) => `${norm(p.name)} ${norm(p.altName ?? "")}`;
  const hits = products.filter((p) => words.every((w) => hay(p).includes(w)));
  const q = norm(query);
  hits.sort((a, b) => Number(norm(b.name) === q) - Number(norm(a.name) === q) || a.name.length - b.name.length);
  return hits.slice(0, limit);
}

const kindLabel: Record<string, string> = { dine_in: "Dine in (with service charge)", takeaway: "Take away", delivery: "Delivery" };

export async function setupTelegramWebhook(integ: Integrations, log: (m: string) => void = console.log): Promise<void> {
  const t = integ.telegram;
  if (!t) return;
  if (!/^https:\/\//.test(integ.publicUrl)) return log("[telegram] PUBLIC_URL is not an https address, so the webhook was not set");
  const f = integ.fetch ?? fetch;
  const call = async (method: string, body: object) => {
    const r = await f(`https://api.telegram.org/bot${t.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  };
  // The host's route to Telegram is sometimes slow to connect, so each step is tried a few times on its own.
  const step = async (name: string, method: string, body: object): Promise<boolean> => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const r = await call(method, body);
        if (r.ok) return true;
        log(`[telegram] ${name} was refused: ${r.description ?? "unknown error"}`);
        return false;
      } catch (e) {
        const c = (e instanceof Error ? e.cause : undefined) as (Error & { code?: string; errors?: (Error & { code?: string })[] }) | undefined;
        const why = [c?.code, ...(c?.errors ?? []).map((x) => x.code ?? x.name)].filter(Boolean).join(" ") || (e instanceof Error ? e.message : String(e));
        log(`[telegram] ${name} attempt ${attempt} failed: ${why}`);
        if (attempt < 5) await new Promise((r) => setTimeout(r, attempt * 4000));
      }
    }
    return false;
  };
  if (await step("webhook", "setWebhook", { url: `${integ.publicUrl}/api/telegram/webhook`, secret_token: t.webhookSecret, allowed_updates: ["message", "callback_query"] })) log(`[telegram] webhook set to ${integ.publicUrl}/api/telegram/webhook`);
  await step("command list", "setMyCommands", {
    commands: [
      { command: "newpricebook", description: "Copy Dine in into a new pricebook and channel" },
      { command: "price", description: "Change one item's price" },
      { command: "off", description: "Switch an item off in a pricebook" },
      { command: "on", description: "Switch an item back on" },
      { command: "edit", description: "Open the web page to edit all items" },
      { command: "pricebooks", description: "List pricebooks and channels" },
      { command: "items", description: "Find an item and its prices" },
      { command: "help", description: "What I can do" },
    ],
  });
}

export function registerTelegram(app: FastifyInstance, d: TelegramDeps): void {
  const t = d.integ.telegram;
  const f = d.integ.fetch ?? fetch;
  const api = async (method: string, body: object): Promise<{ ok?: boolean; result?: any; description?: string }> => {
    if (!t) return { ok: false };
    // The network from the host to Telegram is sometimes slow to connect, so a dropped connection is tried again.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await f(`https://api.telegram.org/bot${t.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return (await r.json().catch(() => ({}))) as { ok?: boolean; result?: any; description?: string };
      } catch {
        if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    return { ok: false };
  };
  const send = (chatId: number, text: string, buttons?: Button[][]) =>
    api("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });

  const merchantLabel = d.merchantId;
  const linkFails = new FailureLimiter(8, 10 * 60_000);
  const redeemFails = new FailureLimiter(10, 10 * 60_000);
  // A name typed with /newpricebook waits here for the channel kind to be chosen. Lost on a restart, which only means asking again.
  const pending = new Map<string, { name: string; at: number }>();
  const putPending = (name: string) => {
    for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60_000) pending.delete(k);
    const id = randomBytes(4).toString("hex");
    pending.set(id, { name, at: Date.now() });
    return id;
  };

  type Who = { staffId: string; name: string; role: "cashier" | "manager" | "owner" };
  const linkedStaff = async (telegramId: number): Promise<Who | null> => {
    const r = await d.db.query(
      `SELECT s.id, s.name, s.role FROM telegram_links l JOIN staff s ON s.id = l.staff_id
        WHERE l.merchant_id=$1 AND l.telegram_id=$2 AND s.active`,
      [d.merchantId, telegramId],
    );
    return r.rows[0] ? { staffId: r.rows[0].id, name: r.rows[0].name, role: r.rows[0].role } : null;
  };

  const webCode = async (who: Who, target: string) => {
    const code = newCode();
    await d.db.query("INSERT INTO telegram_codes (code_hash, merchant_id, staff_id, kind, target, expires_at) VALUES ($1,$2,$3,'web',$4, now() + make_interval(mins => $5))", [sha256(code), d.merchantId, who.staffId, target, WEB_MINUTES]);
    return `${d.integ.publicUrl}/#/tg?code=${code}`;
  };

  const money = formatMoney;
  const priceIn = (c: Catalog, bookId: string, productId: string) => c.pricebooks.find((b) => b.id === bookId)?.prices[productId];
  const bookName = (c: Catalog, id: string) => c.pricebooks.find((b) => b.id === id)?.name ?? id;
  const channelsOf = (c: Catalog, bookId: string) => c.assignments.filter((a) => a.pricebookId === bookId && a.channelId).map((a) => c.channels.find((x) => x.id === a.channelId)?.name ?? a.channelId!);
  const itemLine = (c: Catalog, p: Product) =>
    `${p.name}: ` + c.pricebooks.map((b) => `${b.name} ${b.prices[p.id] === undefined ? "no price" : money(b.prices[p.id]!)}${b.off?.includes(p.id) ? " (off)" : ""}`).join(" · ");

  const help = (chatId: number) =>
    send(
      chatId,
      `I manage the ${merchantLabel} menu prices. Commands:\n\n` +
        `/newpricebook Grab : copy Dine in into a new pricebook and a new channel called Grab\n` +
        `/price kaya toast 2.50 : change one item's price (I'll ask which pricebook)\n` +
        `/off teh : switch an item off in a pricebook (hidden online, greyed out on the till)\n` +
        `/on teh : switch it back on\n` +
        `/edit : a link to a web page where you can edit every item at once\n` +
        `/pricebooks : list pricebooks and which channels use them\n` +
        `/items kaya : find an item and see its prices\n\n` +
        `A price of 0 is allowed: that item sells for free. To stop selling an item in a pricebook, use /off.`,
    );

  // ---- choosing -----------------------------------------------------------------------------------

  const chooseItem = async (chatId: number, prefix: string, items: Product[], cat: Catalog, suffix = "") =>
    send(
      chatId,
      "Which item?",
      items.map((p) => [{ text: `${p.name}${cat.pricebooks.length ? ` (${money(priceIn(cat, cat.defaultPricebookId, p.id) ?? 0)})` : ""}`, callback_data: `${prefix}:${p.id}${suffix}` }]),
    );

  const choosePricebookFor = async (chatId: number, cat: Catalog, makeData: (bookId: string) => string, allData: string, question: string) =>
    send(chatId, question, [...cat.pricebooks.map((b) => [{ text: b.name + (b.id === cat.defaultPricebookId ? " (default)" : ""), callback_data: makeData(b.id) }]), ...(cat.pricebooks.length > 1 ? [[{ text: "All pricebooks", callback_data: allData }]] : [])]);

  // ---- doing --------------------------------------------------------------------------------------

  const applyPrice = async (chatId: number, who: Who, productId: string, bookId: string, cents: number) => {
    const before = await d.cat.load();
    const p = before.products.find((x) => x.id === productId);
    if (!p) return send(chatId, "I can't find that item any more.");
    const ids = bookId === "*" ? before.pricebooks.map((b) => b.id) : [bookId];
    const lines: string[] = [];
    for (const id of ids) {
      const old = priceIn(before, id, productId);
      const r = await d.cat.setPrice(id, productId, cents);
      if (!r.ok) return send(chatId, `I couldn't change ${p.name} in ${bookName(before, id)}: ${r.problems.join("; ")}`);
      await audit(d.db, d.merchantId, who.staffId, "catalog.price", { ...r.detail, via: "telegram" });
      lines.push(`${bookName(before, id)}: ${old === undefined ? "no price" : money(old)} → ${money(cents)}`);
    }
    return send(chatId, `✅ ${p.name}\n${lines.join("\n")}${cents === 0 ? "\n(0 means free: it still sells.)" : ""}`);
  };

  const applyOff = async (chatId: number, who: Who, off: boolean, productId: string, bookId: string) => {
    const before = await d.cat.load();
    const p = before.products.find((x) => x.id === productId);
    if (!p) return send(chatId, "I can't find that item any more.");
    const ids = bookId === "*" ? before.pricebooks.map((b) => b.id) : [bookId];
    const where: string[] = [];
    for (const id of ids) {
      const r = await d.cat.setOff(id, productId, off);
      if (!r.ok) return send(chatId, `I couldn't change ${p.name} in ${bookName(before, id)}: ${r.problems.join("; ")}`);
      await audit(d.db, d.merchantId, who.staffId, "pricebook.off", { ...r.detail, via: "telegram" });
      where.push(bookName(before, id));
    }
    return send(chatId, off ? `⛔ ${p.name} is now OFF in ${where.join(", ")}: hidden from online ordering and greyed out on the till. Its price is kept. /on to bring it back.` : `✅ ${p.name} is back ON in ${where.join(", ")}.`);
  };

  const createPricebook = async (chatId: number, who: Who, name: string, kind: ChannelKind) => {
    const before = await d.cat.load();
    const r = await d.cat.clonePricebook(name, { fromPricebookId: before.defaultPricebookId, kind });
    if (!r.ok) return send(chatId, `I couldn't create it: ${r.problems.join("; ")}`);
    await audit(d.db, d.merchantId, who.staffId, "pricebook.clone", { ...r.detail, via: "telegram" });
    const link = await webCode(who, `pricebook/${r.detail.id}`);
    return send(
      chatId,
      `✅ Created pricebook “${name}”: a copy of ${bookName(before, before.defaultPricebookId)} (${r.detail.copiedPrices} prices and its on/off switches), and a new channel “${name}” (${kindLabel[kind] ?? kind}) that uses it. It is live now.\n\nChange one price: /price <item> <amount>. Change many: open the editor.`,
      [[{ text: `Edit all prices in ${name}`, url: link }]],
    );
  };

  const listBooks = async (chatId: number) => {
    const c = await d.cat.load();
    const lines = c.pricebooks.map((b) => {
      const ch = channelsOf(c, b.id);
      const used = b.id === c.defaultPricebookId ? [...ch, "everything else"] : ch;
      return `• ${b.name}${b.id === c.defaultPricebookId ? " (default)" : ""}: ${Object.keys(b.prices).length} prices${b.off?.length ? `, ${b.off.length} switched off` : ""}\n   used by: ${used.length ? used.join(", ") : "no channel yet"}`;
    });
    return send(chatId, `Pricebooks:\n${lines.join("\n")}`);
  };

  // ---- messages -----------------------------------------------------------------------------------

  async function onMessage(m: TgMessage) {
    if (m.chat.type !== "private" || !m.text || !m.from) return;
    const chatId = m.chat.id;
    const text = m.text.trim();
    if (!text.startsWith("/")) return send(chatId, "Send /help to see what I can do.");
    const word = text.split(/\s+/)[0]!;
    const cmd = word.split("@")[0]!.toLowerCase();
    const arg = text.slice(word.length).trim();

    if (cmd === "/start" || cmd === "/help") {
      const who = await linkedStaff(m.from.id);
      if (!who) return send(chatId, `Hello! I manage the ${merchantLabel} menu. To use me, link your account: on the shop's staff site open Manager > Telegram, press “Link my Telegram”, and send me the code like this:\n\n/link ABCD2345`);
      return help(chatId);
    }
    if (cmd === "/link") {
      const key = String(m.from.id);
      if (linkFails.blocked(key)) return send(chatId, "Too many wrong codes. Wait ten minutes and try again.");
      const code = arg.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const used = await d.db.query(
        `UPDATE telegram_codes SET used_at = now() WHERE code_hash=$1 AND merchant_id=$2 AND kind='link' AND used_at IS NULL AND expires_at > now() RETURNING staff_id`,
        [sha256(code), d.merchantId],
      );
      if (!used.rows[0]) {
        linkFails.fail(key);
        return send(chatId, "That code isn't valid, or it has expired (codes last 10 minutes and work once). Make a new one on the Manager page.");
      }
      const s = await d.db.query("SELECT id, name, role FROM staff WHERE id=$1 AND active", [used.rows[0].staff_id]);
      if (!s.rows[0] || !can(s.rows[0].role, "catalog.manage")) return send(chatId, "That staff account can't manage prices. Only managers and owners can link.");
      await d.db.query(
        `INSERT INTO telegram_links (merchant_id, telegram_id, chat_id, staff_id, name) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (merchant_id, telegram_id) DO UPDATE SET chat_id=EXCLUDED.chat_id, staff_id=EXCLUDED.staff_id, name=EXCLUDED.name`,
        [d.merchantId, m.from.id, chatId, s.rows[0].id, m.from.first_name ?? m.from.username ?? null],
      );
      await audit(d.db, d.merchantId, s.rows[0].id, "telegram.link", { telegramId: m.from.id });
      await send(chatId, `✅ Linked. Hello ${s.rows[0].name}! You are a ${s.rows[0].role}.`);
      return help(chatId);
    }

    const who = await linkedStaff(m.from.id);
    if (!who) return send(chatId, "I don't know you yet. On the shop's staff site open Manager > Telegram, press “Link my Telegram”, and send me the code with /link CODE.");
    if (!can(who.role, "catalog.manage")) return send(chatId, "Only managers and owners can change the menu.");

    const cat = await d.cat.load();
    switch (cmd) {
      case "/pricebooks":
        return listBooks(chatId);
      case "/items": {
        const items = findItems(cat.products, arg, 10);
        if (!arg) return send(chatId, "Send /items and some words from the name, for example /items kaya.");
        return send(chatId, items.length ? items.map((p) => itemLine(cat, p)).join("\n") : `No item matches “${arg}”.`);
      }
      case "/price": {
        const a = parseAmount(arg);
        if (!a) return send(chatId, "Tell me the item and the new price, for example:\n/price kaya toast 2.50\n(0 is allowed: the item then sells for free.)");
        const items = findItems(cat.products, a.query);
        if (!items.length) return send(chatId, `No item matches “${a.query}”. Try /items ${a.query.split(" ")[0]}.`);
        const go = (p: Product) =>
          cat.pricebooks.length === 1
            ? applyPrice(chatId, who, p.id, cat.pricebooks[0]!.id, a.cents)
            : choosePricebookFor(chatId, cat, (b) => `pp:${p.id}:${b}:${a.cents}`, `pp:${p.id}:*:${a.cents}`, `${p.name} to ${money(a.cents)}. In which pricebook?`);
        if (items.length === 1) return go(items[0]!);
        return chooseItem(chatId, "pi", items, cat, `:${a.cents}`);
      }
      case "/off":
      case "/on": {
        const off = cmd === "/off";
        if (!arg) return send(chatId, `Tell me the item, for example: ${cmd} teh`);
        const items = findItems(cat.products, arg);
        if (!items.length) return send(chatId, `No item matches “${arg}”.`);
        const go = (p: Product) =>
          cat.pricebooks.length === 1
            ? applyOff(chatId, who, off, p.id, cat.pricebooks[0]!.id)
            : choosePricebookFor(chatId, cat, (b) => `op:${off ? "off" : "on"}:${p.id}:${b}`, `op:${off ? "off" : "on"}:${p.id}:*`, `${p.name}: switch ${off ? "off" : "on"} in which pricebook?`);
        if (items.length === 1) return go(items[0]!);
        return chooseItem(chatId, off ? "oi:off" : "oi:on", items, cat);
      }
      case "/newpricebook": {
        const name = arg.replace(/\s+/g, " ").slice(0, 40);
        if (!name) return send(chatId, "Give the new pricebook a name, for example:\n/newpricebook Grab");
        if (cat.pricebooks.some((b) => b.name.toLowerCase() === name.toLowerCase()) || cat.channels.some((c) => c.name.toLowerCase() === name.toLowerCase())) return send(chatId, `There is already a pricebook or channel called “${name}”. Pick another name.`);
        const id = putPending(name);
        return send(chatId, `I'll copy ${bookName(cat, cat.defaultPricebookId)} into a new pricebook “${name}” and make a channel “${name}”. What kind of channel is it?`, [
          [{ text: "Dine in (with service charge)", callback_data: `nk:${id}:dine_in` }],
          [{ text: "Take away", callback_data: `nk:${id}:takeaway` }],
          [{ text: "Delivery", callback_data: `nk:${id}:delivery` }],
        ]);
      }
      case "/edit": {
        const open = async (bookId: string) => send(chatId, `Open the editor for ${bookName(cat, bookId)}. The link works once, for ${WEB_MINUTES} minutes.`, [[{ text: `Edit ${bookName(cat, bookId)}`, url: await webCode(who, `pricebook/${bookId}`) }]]);
        if (cat.pricebooks.length === 1) return open(cat.pricebooks[0]!.id);
        return send(chatId, "Which pricebook?", cat.pricebooks.map((b) => [{ text: b.name, callback_data: `ed:${b.id}` }]));
      }
      default:
        return send(chatId, "I don't know that one. Send /help.");
    }
  }

  async function onCallback(q: TgCallback) {
    await api("answerCallbackQuery", { callback_query_id: q.id });
    const chatId = q.message?.chat.id;
    if (!chatId || !q.data || q.message?.chat.type !== "private") return;
    const who = await linkedStaff(q.from.id);
    if (!who || !can(who.role, "catalog.manage")) return send(chatId, "I don't know you, or you can't change the menu.");
    const parts = q.data.split(":");
    const cat = await d.cat.load();
    const known = (id: string) => cat.pricebooks.some((b) => b.id === id) || id === "*";
    switch (parts[0]) {
      case "pi": {
        const [, productId, cents] = parts;
        const p = cat.products.find((x) => x.id === productId);
        const c = Number(cents);
        if (!p || !Number.isSafeInteger(c)) return;
        if (cat.pricebooks.length === 1) return applyPrice(chatId, who, p.id, cat.pricebooks[0]!.id, c);
        return choosePricebookFor(chatId, cat, (b) => `pp:${p.id}:${b}:${c}`, `pp:${p.id}:*:${c}`, `${p.name} to ${money(c)}. In which pricebook?`);
      }
      case "pp": {
        const [, productId, bookId, cents] = parts;
        const c = Number(cents);
        if (!productId || !bookId || !known(bookId) || !Number.isSafeInteger(c) || c < 0 || c > MAX_CENTS) return;
        return applyPrice(chatId, who, productId, bookId, c);
      }
      case "oi": {
        const [, mode, productId] = parts;
        const p = cat.products.find((x) => x.id === productId);
        if (!p || (mode !== "on" && mode !== "off")) return;
        if (cat.pricebooks.length === 1) return applyOff(chatId, who, mode === "off", p.id, cat.pricebooks[0]!.id);
        return choosePricebookFor(chatId, cat, (b) => `op:${mode}:${p.id}:${b}`, `op:${mode}:${p.id}:*`, `${p.name}: switch ${mode} in which pricebook?`);
      }
      case "op": {
        const [, mode, productId, bookId] = parts;
        if (!productId || !bookId || !known(bookId) || (mode !== "on" && mode !== "off")) return;
        return applyOff(chatId, who, mode === "off", productId, bookId);
      }
      case "nk": {
        const [, id, kind] = parts;
        const p = id ? pending.get(id) : undefined;
        if (!p || !(kind === "dine_in" || kind === "takeaway" || kind === "delivery")) return send(chatId, "That choice has expired. Send /newpricebook again.");
        pending.delete(id!);
        return createPricebook(chatId, who, p.name, kind);
      }
      case "ed": {
        const bookId = parts[1];
        if (!bookId || !known(bookId) || bookId === "*") return;
        return send(chatId, `Open the editor for ${bookName(cat, bookId)}. The link works once, for ${WEB_MINUTES} minutes.`, [[{ text: `Edit ${bookName(cat, bookId)}`, url: await webCode(who, `pricebook/${bookId}`) }]]);
      }
    }
  }

  // ---- routes -------------------------------------------------------------------------------------

  /** Telegram posts every message here. The secret header proves it is Telegram; anything else is refused. */
  app.post<{ Body: TgUpdate }>("/api/telegram/webhook", async (req, reply) => {
    if (!t) return reply.code(404).send({ error: "telegram_not_set_up" });
    const got = req.headers["x-telegram-bot-api-secret-token"];
    if (typeof got !== "string" || !sameSecret(got, t.webhookSecret)) return reply.code(401).send({ error: "bad_secret" });
    const u = req.body ?? {};
    try {
      if (u.callback_query) await onCallback(u.callback_query);
      else if (u.message) await onMessage(u.message);
    } catch (e) {
      console.error("[telegram] error handling an update:", e instanceof Error ? e.message : e);
    }
    return { ok: true }; // always answered, so Telegram does not retry a message we could not handle
  });

  let botName: string | undefined;
  app.get("/api/telegram/status", { preHandler: d.needs("catalog.manage") as never }, async () => {
    if (!t) return { configured: false, linked: [] };
    if (!botName) botName = (await api("getMe", {})).result?.username;
    const r = await d.db.query(
      `SELECT l.telegram_id, l.name, l.created_at, s.name AS staff_name, s.role FROM telegram_links l JOIN staff s ON s.id=l.staff_id WHERE l.merchant_id=$1 ORDER BY l.created_at`,
      [d.merchantId],
    );
    return { configured: true, bot: botName ?? null, linked: r.rows.map((x) => ({ telegramId: String(x.telegram_id), name: x.name as string | null, staffName: x.staff_name as string, role: x.role as string, since: x.created_at as Date })) };
  });

  app.post("/api/telegram/link-code", { preHandler: d.needs("catalog.manage") as never }, async (req, reply) => {
    if (!t) return reply.code(404).send({ error: "telegram_not_set_up" });
    const code = newCode();
    await d.db.query("INSERT INTO telegram_codes (code_hash, merchant_id, staff_id, kind, expires_at) VALUES ($1,$2,$3,'link', now() + make_interval(mins => $4))", [sha256(code), d.merchantId, req.staff!.id, LINK_MINUTES]);
    if (!botName) botName = (await api("getMe", {})).result?.username;
    return { code, minutes: LINK_MINUTES, bot: botName ?? null };
  });

  app.delete<{ Params: { telegramId: string } }>("/api/telegram/links/:telegramId", { preHandler: d.needs("catalog.manage") as never }, async (req, reply) => {
    if (!/^\d+$/.test(req.params.telegramId)) return reply.code(400).send({ error: "bad_id" });
    const r = await d.db.query("DELETE FROM telegram_links WHERE merchant_id=$1 AND telegram_id=$2", [d.merchantId, req.params.telegramId]);
    if (!r.rowCount) return reply.code(404).send({ error: "not_linked" });
    await audit(d.db, d.merchantId, req.staff!.id, "telegram.unlink", { telegramId: req.params.telegramId });
    return { ok: true };
  });

  /** The web editor link from Telegram: a one-time code buys a browser its own device and a staff session, no PIN needed. */
  app.post<{ Body: { code?: string } }>("/api/telegram/redeem", async (req, reply) => {
    if (!t) return reply.code(404).send({ error: "telegram_not_set_up" });
    if (redeemFails.blocked(req.ip)) return reply.code(429).send({ error: "too_many_attempts" });
    const code = String(req.body?.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const used = await d.db.query(
      `UPDATE telegram_codes SET used_at = now() WHERE code_hash=$1 AND merchant_id=$2 AND kind='web' AND used_at IS NULL AND expires_at > now() RETURNING staff_id, target`,
      [sha256(code), d.merchantId],
    );
    if (!used.rows[0]) {
      redeemFails.fail(req.ip);
      return reply.code(401).send({ error: "invalid_or_expired_code" });
    }
    const staff = await d.db.query("SELECT id, name, role FROM staff WHERE id=$1 AND active", [used.rows[0].staff_id]);
    if (!staff.rows[0] || !can(staff.rows[0].role, "catalog.manage")) return reply.code(403).send({ error: "not_allowed" });
    const device = await createLinkedDevice(d.db, d.merchantId, d.outletId, `Telegram (${staff.rows[0].name})`, staff.rows[0].id);
    const session = await startSessionFor(d.db, d.merchantId, staff.rows[0].id, "telegram");
    if (!session) return reply.code(403).send({ error: "not_allowed" });
    await audit(d.db, d.merchantId, staff.rows[0].id, "telegram.web", { deviceId: device.device.id });
    return { deviceToken: device.token, deviceId: device.device.id, token: session.token, expiresAt: session.expiresAt, staff: { name: session.staff.name, code: session.staff.code, role: session.staff.role }, to: used.rows[0].target as string };
  });
}
