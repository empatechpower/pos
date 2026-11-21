import { createHash, randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { formatMoney, type Catalog, type ChannelKind, type Product } from "@pos/core";
import { audit, can, createStaff, startSessionFor, type Permission } from "./auth.js";
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
interface TgPhoto { file_id: string; file_size?: number; width?: number; height?: number }
interface TgMessage { message_id: number; chat: { id: number; type: string }; from?: TgUser; text?: string; caption?: string; photo?: TgPhoto[]; document?: { file_id: string; file_size?: number; mime_type?: string } }
interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { message?: TgMessage; callback_query?: TgCallback }

export interface TelegramDeps {
  db: Db;
  merchantId: string;
  outletId: string;
  integ: Integrations;
  cat: PgCatalogStore;
  needs: (permission: Permission) => (req: FastifyRequest, reply: FastifyReply) => unknown;
  /** Sales and order data for /sales and /orders. */
  reports?: {
    sales: (from?: string, to?: string) => Promise<{ from: string; to: string; orders: number; items: number; grossCents: number; serviceCents: number; averageOrderCents: number; byChannel: { commissionCents?: number; channel: string; orders: number; cents: number }[]; products: { name: string; qty: number; cents: number }[] }>;
    orders: (from?: string, to?: string, includeCancelled?: boolean) => Promise<{ from: string; to: string; count: number; orders: { orderId: string; queueNumber: string | null; openedAt: string; channel: string; table: string | null; stage: string; customerName: string | null; lines: { name: string; qty: number; unitCents: number; options: string[] }[]; subtotalCents: number; serviceCents: number; totalCents: number; paidCents: number }[] }>;
    today: () => string;
    /** The hour (0-23) in the shop's time zone, for the end-of-day summary. */
    hour?: () => number;
  };
  /** The owner's operator settings for /settings (Q&A E-1: payment/service options day one, as a guided operation). */
  settings?: {
    brand: () => Array<{ key: string; label: string; on: boolean }>;
    setBrand: (key: string, on: boolean, staffId: string) => Promise<boolean>;
    outlets: () => Promise<Array<{ id: string; name: string; tableService: boolean; tabService: boolean; allocation: "oldest_first" | "reduce_only" }>>;
    setOutlet: (id: string, change: { tabService?: boolean; allocation?: string }, staffId: string) => Promise<string | null>;
  };
  /** Open tables for /tabs. */
  tabs?: { open: () => Promise<Array<{ spot: string | null; people: number; paged: string | null; billRequested: boolean; totalCents: number; paidCents: number; remainingCents: number }>> };
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

const MAX_PHOTO_BYTES = 300 * 1024;
const csvCell = (v: unknown) => {
  const t = String(v ?? "");
  // A cell that starts with = + - @ can run as a formula in a spreadsheet, so it is shown as plain text.
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** "today", "yesterday", "week" (last 7 days), "month" (last 30 days) or a date like 2026-11-14 (or two dates). Dates are Singapore days. */
export function parseRange(arg: string, today: string): { from: string; to: string; label: string } | null {
  const a = arg.trim().toLowerCase();
  const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  if (a === "" || a === "today") return { from: today, to: today, label: "today" };
  if (a === "yesterday") return { from: shift(today, -1), to: shift(today, -1), label: "yesterday" };
  if (a === "week") return { from: shift(today, -6), to: today, label: "the last 7 days" };
  if (a === "month") return { from: shift(today, -29), to: today, label: "the last 30 days" };
  const d = a.match(/\d{4}-\d{2}-\d{2}/g);
  if (d && d.length <= 2 && a.replace(/\d{4}-\d{2}-\d{2}|[\s,to-]/g, "") === "") {
    const [x, y] = [d[0]!, d[1] ?? d[0]!];
    if ([x, y].every((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) return x <= y ? { from: x, to: y, label: x === y ? x : `${x} to ${y}` } : { from: y, to: x, label: `${y} to ${x}` };
  }
  return null;
}

/** "Latte > Flat White", "Latte → Flat White" or "Latte to Flat White": the old name and the new one. */
export function parseRename(text: string): { from: string; to: string } | null {
  const m = /^(.*?\S)\s*(?:->|=>|→|>)\s*(\S.*)$/.exec(text.trim()) ?? /^(.*?\S)\s+to\s+(\S.*)$/i.exec(text.trim());
  if (!m) return null;
  const to = m[2]!.replace(/\s+/g, " ").trim().slice(0, 60);
  return to ? { from: m[1]!.trim(), to } : null;
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
      { command: "manager", description: "Open the Manager page, signed in" },
      { command: "online", description: "Open Online orders, signed in" },
      { command: "printers", description: "Open Printers, signed in" },
      { command: "prices", description: "Open Prices, signed in" },
      { command: "edit", description: "Open the web page to edit all items" },
      { command: "pricebooks", description: "List pricebooks and channels" },
      { command: "items", description: "Find an item and its prices" },
      { command: "rename", description: "Rename an item or category" },
      { command: "sales", description: "Sales totals for a day or period" },
      { command: "orders", description: "Orders as a spreadsheet file" },
      { command: "tabs", description: "Open tables and what is owed" },
      { command: "settings", description: "Service charge, tax, points, tabs" },
      { command: "help", description: "What I can do" },
    ],
  });
}

export function registerTelegram(app: FastifyInstance, d: TelegramDeps): void {
  const t = d.integ.telegram;
  const f = d.integ.fetch ?? fetch;
  const api = async (method: string, body: object, tries = 4): Promise<{ ok?: boolean; result?: any; description?: string }> => {
    if (!t) return { ok: false };
    // The network from the host to Telegram is sometimes slow to connect, so a dropped connection is tried again.
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        // Give up on a stuck connection after 5 seconds and try again, rather than waiting out the long default.
        const r = await f(`https://api.telegram.org/bot${t.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        return (await r.json().catch(() => ({}))) as { ok?: boolean; result?: any; description?: string };
      } catch {
        if (attempt < tries) await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
    return { ok: false };
  };
  const send = (chatId: number, text: string, buttons?: Button[][]) =>
    api("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });

  /** Tell every linked manager and owner something that needs attention (printer and table alerts). `all` also reaches every other linked staff member. Does nothing without a Telegram bot. */
  (app as unknown as { notifyManagers?: (text: string, all?: boolean) => Promise<void> }).notifyManagers = async (text: string, all = false) => {
    if (!t) return;
    const r = await d.db.query(
      `SELECT DISTINCT l.chat_id FROM telegram_links l JOIN staff s ON s.id = l.staff_id WHERE l.merchant_id=$1 AND s.active ${all ? "" : "AND s.role IN ('owner','manager')"}`,
      [d.merchantId],
    );
    for (const row of r.rows) await send(Number(row.chat_id), text);
  };

  /**
   * Day-one reporting: once a day, after DAILY_SUMMARY_HOUR (default 22, the shop's time; "off" turns it off), the day's sales go to
   * every linked manager and owner. The day is claimed in the database first so two server instances never send it twice.
   */
  const summaryHour = /^off$/i.test(process.env.DAILY_SUMMARY_HOUR ?? "") ? null : (() => { const n = Number(process.env.DAILY_SUMMARY_HOUR ?? ""); return process.env.DAILY_SUMMARY_HOUR?.trim() && Number.isInteger(n) && n >= 0 && n <= 23 ? n : 22; })();
  const sendDailySummary = async (): Promise<boolean> => {
    if (!t || summaryHour === null || !d.reports?.hour || d.reports.hour() < summaryHour) return false;
    const today = d.reports.today();
    const won = await d.db.query(
      "INSERT INTO merchant_settings (merchant_id, key, value) VALUES ($1,'dailySummaryLast',$2::jsonb) ON CONFLICT (merchant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now() WHERE merchant_settings.value IS DISTINCT FROM EXCLUDED.value RETURNING 1",
      [d.merchantId, JSON.stringify(today)],
    );
    if (!won.rowCount) return false;
    const text = await salesMessage("today");
    if (text.startsWith("No sales")) return false;
    await (app as unknown as { notifyManagers: (x: string) => Promise<void> }).notifyManagers(`End of day\n${text}`);
    return true;
  };
  (app as unknown as { sendDailySummary?: () => Promise<boolean> }).sendDailySummary = sendDailySummary;
  if (t && summaryHour !== null && process.env.NODE_ENV !== "test") {
    const timer = setInterval(() => { void sendDailySummary().catch(() => undefined); }, 60_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }

  /** Send a small text file (a CSV) into the chat. */
  const sendFile = async (chatId: number, filename: string, content: string, caption: string) => {
    if (!t) return;
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("caption", caption);
    form.append("document", new Blob([content], { type: "text/csv" }), filename);
    try {
      await f(`https://api.telegram.org/bot${t.token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) });
    } catch {
      await send(chatId, "I couldn't send the file just now. Try again in a minute.");
    }
  };
  /** Fetch a file the user sent to the bot (a photo). Null if Telegram will not give it. */
  const download = async (fileId: string): Promise<Buffer | null> => {
    if (!t) return null;
    const info = await api("getFile", { file_id: fileId });
    const path = info.result?.file_path as string | undefined;
    if (!path) return null;
    try {
      const r = await f(`https://api.telegram.org/file/bot${t.token}/${path}`, { signal: AbortSignal.timeout(15_000) });
      return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };

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

  // A photo waits here while the manager picks which item it belongs to (the id is short because a button can carry only 64 bytes).
  const photos = new Map<string, { fileId: string; at: number }>();
  const putPhoto = (fileId: string) => {
    for (const [k, v] of photos) if (Date.now() - v.at > 15 * 60_000) photos.delete(k);
    const id = randomBytes(4).toString("hex");
    photos.set(id, { fileId, at: Date.now() });
    return id;
  };

  type Who = { staffId: string; name: string; role: "cashier" | "manager" | "owner" };
  const linkedStaff = async (telegramId: number, from?: TgUser): Promise<Who | null> => {
    const r = await d.db.query(
      `SELECT s.id, s.name, s.role, s.code FROM telegram_links l JOIN staff s ON s.id = l.staff_id
        WHERE l.merchant_id=$1 AND l.telegram_id=$2 AND s.active`,
      [d.merchantId, telegramId],
    );
    // The old shared "Telegram manager" login is replaced by a personal one below, so each person is named in the audit log.
    if (r.rows[0] && !(r.rows[0].code === "TGMGR" && t?.managerIds?.includes(String(telegramId)))) return { staffId: r.rows[0].id, name: r.rows[0].name, role: r.rows[0].role };
    // A Telegram account named in TELEGRAM_ADMIN_IDS is the owner's: it is linked to the owner's staff login the first time it speaks, so no code is needed.
    if (t?.adminIds?.includes(String(telegramId))) {
      const owner = await d.db.query("SELECT id, name, role FROM staff WHERE merchant_id=$1 AND role='owner' AND active ORDER BY created_at LIMIT 1", [d.merchantId]);
      if (owner.rows[0]) {
        await d.db.query(
          "INSERT INTO telegram_links (merchant_id, telegram_id, chat_id, staff_id, name) VALUES ($1,$2,$2,$3,$4) ON CONFLICT (merchant_id, telegram_id) DO UPDATE SET staff_id=EXCLUDED.staff_id",
          [d.merchantId, telegramId, owner.rows[0].id, "owner (by Telegram id)"],
        );
        await audit(d.db, d.merchantId, owner.rows[0].id, "telegram.autolink", { telegramId });
        return { staffId: owner.rows[0].id, name: owner.rows[0].name, role: owner.rows[0].role };
      }
    }
    // A Telegram account named in TELEGRAM_MANAGER_IDS gets a manager login of its own (never the owner's), one per person, named after their Telegram
    // profile so the audit log says who did what. It can manage prices, products, orders and printers, but cannot manage staff. The login has a random
    // PIN nobody knows, so it works only through Telegram.
    if (t?.managerIds?.includes(String(telegramId))) {
      const code = `TG${telegramId}`;
      const display = `Telegram: ${[from?.first_name, from?.username ? `@${from.username}` : ""].filter(Boolean).join(" ") || telegramId}`.slice(0, 60);
      let mgr = (await d.db.query("SELECT id, name, role FROM staff WHERE merchant_id=$1 AND code=$2 AND role='manager' AND active", [d.merchantId, code])).rows[0];
      if (!mgr) {
        const made = await createStaff(d.db, { merchantId: d.merchantId, code, name: display, role: "manager", pin: String(randomInt(10_000_000, 100_000_000)) });
        mgr = { id: made.id, name: made.name, role: made.role };
      }
      await d.db.query(
        "INSERT INTO telegram_links (merchant_id, telegram_id, chat_id, staff_id, name) VALUES ($1,$2,$2,$3,$4) ON CONFLICT (merchant_id, telegram_id) DO UPDATE SET staff_id=EXCLUDED.staff_id",
        [d.merchantId, telegramId, mgr.id, "manager (by Telegram id)"],
      );
      await audit(d.db, d.merchantId, mgr.id, "telegram.autolink", { telegramId, role: "manager" });
      return { staffId: mgr.id, name: mgr.name, role: mgr.role };
    }
    return null;
  };

  const webCode = async (who: Who, target: string) => {
    const code = newCode();
    await d.db.query("INSERT INTO telegram_codes (code_hash, merchant_id, staff_id, kind, target, expires_at) VALUES ($1,$2,$3,'web',$4, now() + make_interval(mins => $5))", [sha256(code), d.merchantId, who.staffId, target, WEB_MINUTES]);
    return `${d.integ.publicUrl}/tg?code=${code}`;
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
        `/manager, /online, /printers, /prices : a link that opens that page, already signed in (no code or PIN)\n` +
        `/edit : a link to a web page where you can edit every item at once\n` +
        `/pricebooks : list pricebooks and which channels use them\n` +
        `/items kaya : find an item and see its prices\n` +
        `/rename Latte > Flat White : rename an item, or a whole category\n` +
        `Send a photo with the item's name as the caption : sets that item's picture\n` +
        `/sales today (or yesterday, week, month, or a date) : sales totals and top items\n` +
        `/tabs : open tables and what is owed\n` +
        `/orders week : the orders as a spreadsheet file\n\n` +
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

  const applyRename = async (chatId: number, who: Who, productId: string, to: string) => {
    const p = (await d.cat.load()).products.find((x) => x.id === productId);
    if (!p) return send(chatId, "I can't find that item any more.");
    const r = await d.cat.upsertProduct({ id: p.id, name: to, category: p.category, soldOut: p.soldOut, pointsExempt: p.pointsExempt });
    if (!r.ok) return send(chatId, `I couldn't rename it: ${r.problems.join("; ")}`);
    await audit(d.db, d.merchantId, who.staffId, "catalog.product", { ...r.detail, was: p.name, via: "telegram" });
    return send(chatId, `✅ ${p.name} is now “${to}”. Its price, options and photo are unchanged.`);
  };

  const applyCategoryRename = async (chatId: number, who: Who, from: string, to: string) => {
    const r = await d.cat.renameCategory(from, to);
    if (!r.ok) return send(chatId, `I couldn't rename it: ${r.problems.join("; ")}`);
    await audit(d.db, d.merchantId, who.staffId, "catalog.category", { ...r.detail, via: "telegram" });
    return send(chatId, `✅ Category “${from}” is now “${to}” (${r.detail.items} items moved). Printers that list it keep printing it.`);
  };

  const applyPhoto = async (chatId: number, who: Who, productId: string, fileId: string) => {
    const p = (await d.cat.load()).products.find((x) => x.id === productId);
    if (!p) return send(chatId, "I can't find that item any more.");
    const bytes = await download(fileId);
    if (!bytes) return send(chatId, "I couldn't get that photo from Telegram. Send it again.");
    const r = await d.cat.setImage(productId, bytes);
    if (!r.ok) return send(chatId, `I couldn't use that photo: ${r.problems.join("; ")}`);
    await audit(d.db, d.merchantId, who.staffId, "product.image", { ...r.detail, via: "telegram" });
    return send(chatId, `✅ New picture for ${p.name}. It shows on the menu now.`);
  };

  /** The operator settings as buttons: tap one to switch it. Brand-wide options first, then each outlet's table-service options. */
  const showSettings = async (chatId: number) => {
    if (!d.settings) return send(chatId, "Settings aren't available here.");
    const brand = d.settings.brand();
    const outlets = await d.settings.outlets();
    const rows: Button[][] = brand.map((b) => [{ text: `${b.on ? "✅" : "⬜"} ${b.label}`, callback_data: `st:${b.key}:${b.on ? 0 : 1}` }]);
    for (const o of outlets) {
      if (!o.tableService) continue;
      rows.push([{ text: `${o.tabService ? "✅" : "⬜"} ${o.name}: Add to Tab`, callback_data: `so:${o.id}:ts:${o.tabService ? 0 : 1}` }]);
      rows.push([{ text: `${o.name}: custom amount ${o.allocation === "reduce_only" ? "reduces the total only" : "pays the oldest round first"} (tap to switch)`, callback_data: `so:${o.id}:al:${o.allocation === "reduce_only" ? "oldest_first" : "reduce_only"}` }]);
    }
    return send(chatId, "Settings. Tap one to switch it. Open screens pick a change up on their next reload.", rows);
  };

  const salesMessage = async (arg: string): Promise<string> => {
    if (!d.reports) return "Reports aren't available here.";
    const range = parseRange(arg, d.reports.today());
    if (!range) return "Try /sales today, /sales yesterday, /sales week, /sales month, or a date like /sales 2026-11-14.";
    const r = await d.reports.sales(range.from, range.to);
    if (!r.orders) return `No sales for ${range.label}.`;
    const top = r.products.slice(0, 8).map((x, i) => `${i + 1}. ${x.name}: ${x.qty} (${money(x.cents)})`).join("\n");
    const ch = r.byChannel.map((x) => `${x.channel}: ${x.orders} orders, ${money(x.cents)}${x.commissionCents !== undefined ? ` (commission ${money(x.commissionCents)})` : ""}`).join("\n");
    return `Sales for ${range.label} (${r.from}${r.from === r.to ? "" : ` to ${r.to}`})\n${r.orders} orders · ${r.items} items\nTotal ${money(r.grossCents)} (service charge ${money(r.serviceCents)}) · average ${money(r.averageOrderCents)}\n\n${ch}\n\nTop items:\n${top}\n\nFor every order as a spreadsheet: /orders ${arg || "today"}`;
  };
  const showSales = async (chatId: number, arg: string) => send(chatId, await salesMessage(arg));

  const sendOrders = async (chatId: number, arg: string) => {
    if (!d.reports) return send(chatId, "Reports aren't available here.");
    const range = parseRange(arg, d.reports.today());
    if (!range) return send(chatId, "Try /orders today, /orders yesterday, /orders week, /orders month, or a date like /orders 2026-11-14.");
    const r = await d.reports.orders(range.from, range.to);
    if (!r.count) return send(chatId, `No orders for ${range.label}.`);
    const head = ["order", "queue", "opened", "channel", "table", "customer", "stage", "items", "subtotal", "service", "total", "paid"];
    const rows = r.orders.map((o) => [o.orderId, o.queueNumber ?? "", o.openedAt, o.channel, o.table ?? "", o.customerName ?? "", o.stage, o.lines.map((l) => `${l.qty}x ${l.name}${l.options.length ? ` (${l.options.join(", ")})` : ""}`).join("; "), (o.subtotalCents / 100).toFixed(2), (o.serviceCents / 100).toFixed(2), (o.totalCents / 100).toFixed(2), (o.paidCents / 100).toFixed(2)]);
    const csv = [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    return sendFile(chatId, `orders-${r.from}${r.from === r.to ? "" : `-to-${r.to}`}.csv`, csv, `${r.count} orders for ${range.label}. Amounts are in dollars.`);
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
    if (m.chat.type !== "private" || !m.from) return;
    const chatId = m.chat.id;
    const fileId = m.photo?.length ? [...m.photo].filter((x) => !x.file_size || x.file_size <= MAX_PHOTO_BYTES).sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0]?.file_id : m.document?.mime_type?.startsWith("image/") && (m.document.file_size ?? 0) <= MAX_PHOTO_BYTES ? m.document.file_id : undefined;
    if (!m.text && (m.photo?.length || m.document)) {
      const who = await linkedStaff(m.from.id, m.from);
      if (!who || !can(who.role, "catalog.manage")) return send(chatId, "I don't know you, or you can't change the menu.");
      if (!fileId) return send(chatId, "That photo is too big. Send one under 300 KB (a smaller or compressed picture), as a normal photo.");
      const name = (m.caption ?? "").replace(/^\/photo(?:@\S+)?\s*/i, "").trim();
      if (!name) return send(chatId, "Send the photo again with the item's name as the caption, for example: kaya toast");
      const items = findItems((await d.cat.load()).products, name);
      if (!items.length) return send(chatId, `No item matches “${name}”. Try /items ${name.split(" ")[0]}.`);
      if (items.length === 1) return applyPhoto(chatId, who, items[0]!.id, fileId);
      const pid = putPhoto(fileId);
      return send(chatId, "Which item is the photo for?", items.map((p) => [{ text: p.name, callback_data: `ph:${pid}:${p.id}` }]));
    }
    if (!m.text) return;
    const text = m.text.trim();
    if (!text.startsWith("/")) return send(chatId, "Send /help to see what I can do.");
    const word = text.split(/\s+/)[0]!;
    const cmd = word.split("@")[0]!.toLowerCase();
    const arg = text.slice(word.length).trim();

    if (cmd === "/start" || cmd === "/help") {
      const who = await linkedStaff(m.from.id, m.from);
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

    const who = await linkedStaff(m.from.id, m.from);
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
      case "/rename": {
        const rn = parseRename(arg);
        if (!rn) return send(chatId, "Tell me the old and new name, for example:\n/rename Latte > Flat White\nFor a category: /rename Drinks > Beverages");
        const cats = [...new Set(cat.products.map((p) => p.category))];
        const asCategory = cats.find((c) => norm(c) === norm(rn.from));
        if (asCategory) return applyCategoryRename(chatId, who, asCategory, rn.to);
        const items = findItems(cat.products, rn.from);
        if (!items.length) return send(chatId, `No item or category matches “${rn.from}”. Try /items ${rn.from.split(" ")[0]}.`);
        if (items.length === 1) return applyRename(chatId, who, items[0]!.id, rn.to);
        const id = putPending(rn.to);
        return send(chatId, `Rename which item to “${rn.to}”?`, items.map((p) => [{ text: p.name, callback_data: `rn:${id}:${p.id}` }]));
      }
      case "/sales":
        if (!can(who.role, "audit.read")) return send(chatId, "Only managers and owners can see sales.");
        return showSales(chatId, arg);
      case "/settings":
        if (!can(who.role, "staff.manage")) return send(chatId, "Only the owner can change settings.");
        return showSettings(chatId);
      case "/tabs": {
        if (!d.tabs) return send(chatId, "Tables aren't available here.");
        const list = await d.tabs.open();
        if (!list.length) return send(chatId, "No open tabs.");
        return send(chatId, `Open tabs (${list.length})\n` + list.map((x) => `${x.paged ? (x.paged === "bill" ? "🧾 " : "🔔 ") : "• "}${x.spot ?? "Table"}: ${money(x.remainingCents)} to pay of ${money(x.totalCents)} · ${x.people} ${x.people === 1 ? "person" : "people"}${x.paged === "bill" ? " · asking for the bill" : x.paged ? " · needs the waiter" : ""}`).join("\n"));
      }
      case "/orders":
        if (!can(who.role, "audit.read")) return send(chatId, "Only managers and owners can see orders.");
        return sendOrders(chatId, arg);
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
      case "/manager":
      case "/online":
      case "/printers":
      case "/prices": {
        const page = cmd.slice(1);
        const names: Record<string, string> = { manager: "Manager", online: "Online orders", printers: "Printers", prices: "Prices" };
        return send(chatId, `Open ${names[page]}. The link signs you in on that browser, works once, and lasts ${WEB_MINUTES} minutes.`, [[{ text: `Open ${names[page]}`, url: await webCode(who, page) }]]);
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
    const who = await linkedStaff(q.from.id, q.from);
    if (!who || !can(who.role, "catalog.manage")) return send(chatId, "I don't know you, or you can't change the menu.");
    const parts = q.data.split(":");
    if (parts[0] === "st" || parts[0] === "so") {
      if (!can(who.role, "staff.manage") || !d.settings) return send(chatId, "Only the owner can change settings.");
      if (parts[0] === "st") {
        if (!(await d.settings.setBrand(parts[1]!, parts[2] === "1", who.staffId))) return send(chatId, "I don't know that setting.");
      } else {
        const outletId = parts.slice(1, -2).join(":");
        const change = parts[parts.length - 2] === "ts" ? { tabService: parts[parts.length - 1] === "1" } : { allocation: parts[parts.length - 1]! };
        const problem = await d.settings.setOutlet(outletId, change, who.staffId);
        if (problem) return send(chatId, problem);
      }
      return showSettings(chatId);
    }
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
      case "rn": {
        const [, id, productId] = parts;
        const p = id ? pending.get(id) : undefined;
        if (!p || !productId) return send(chatId, "That choice has expired. Send /rename again.");
        pending.delete(id!);
        return applyRename(chatId, who, productId, p.name);
      }
      case "ph": {
        const [, id, productId] = parts;
        const p = id ? photos.get(id) : undefined;
        if (!p || !productId) return send(chatId, "That choice has expired. Send the photo again.");
        photos.delete(id!);
        return applyPhoto(chatId, who, productId, p.fileId);
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
    // Show "typing…" at once so a slow reply does not look like silence. Best effort: one try, never waited for.
    if (u.message?.chat.type === "private") void api("sendChatAction", { chat_id: u.message.chat.id, action: "typing" }, 1);
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
