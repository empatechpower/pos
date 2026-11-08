import {
  encodeEpl, encodeEscPos, encodeZpl, isFullyPaid, itemLabel, kitchenTicket, receipt, visibleToKitchen, withDrawer,
  type BusinessConfig, type Catalog, type Doc, type Label, type OrderLine, type OrderState, type PrintContext, type PrinterLanguage,
} from "@pos/core";
import { createHash } from "node:crypto";
import type pg from "pg";
import type { Db } from "./db/pool.js";

export type DocType = "receipt" | "kitchen" | "label" | "test";
export type Role = "receipt" | "kitchen" | "label";

export interface Printer {
  id: string;
  name: string;
  outletId: string;
  language: PrinterLanguage;
  roles: Role[];
  categories: string[];
  widthChars: number;
  drawer: boolean;
  labelWidthMm: number | null;
  labelHeightMm: number | null;
  dpi: 203 | 300;
  connection: { host: string; port: number };
  agentDeviceId: string | null;
  active: boolean;
}

export const MAX_ATTEMPTS = 5;
export const LEASE_SECONDS = 60;
/** Wait before retrying a failed delivery: 5 s, 15 s, 45 s, 2 min. */
export const backoffSeconds = (attempt: number) => Math.min(120, 5 * 3 ** Math.max(0, attempt - 1));

const toPrinter = (r: Record<string, any>): Printer => ({
  id: r.id, name: r.name, outletId: r.outlet_id, language: r.language, roles: r.roles, categories: r.categories, widthChars: r.width_chars,
  drawer: r.drawer, labelWidthMm: r.label_width_mm, labelHeightMm: r.label_height_mm, dpi: r.dpi === 300 ? 300 : 203,
  connection: r.connection, agentDeviceId: r.agent_device_id, active: r.active,
});

/** Receipt and kitchen printers speak ESC/POS; label printers speak ZPL or EPL. Checked before saving. */
export function validatePrinter(p: Partial<Printer>): string[] {
  const problems: string[] = [];
  if (!p.id || !/^[a-z0-9-]{1,40}$/.test(p.id)) problems.push("id must be lowercase letters, digits and dashes");
  if (!p.name?.trim()) problems.push("name is required");
  if (!p.language || !["escpos", "zpl", "epl"].includes(p.language)) problems.push("language must be escpos, zpl or epl");
  if (!p.roles?.length || p.roles.some((r) => !["receipt", "kitchen", "label"].includes(r))) problems.push("roles must be receipt, kitchen and/or label");
  const text = p.roles?.some((r) => r === "receipt" || r === "kitchen");
  const lab = p.roles?.includes("label");
  if (text && p.language !== "escpos") problems.push("receipt and kitchen printers must use escpos");
  if (lab && p.language === "escpos") problems.push("label printers must use zpl or epl");
  if (text && lab) problems.push("a printer is either for paper tickets or for labels, not both");
  if (lab && !(p.labelWidthMm && p.labelHeightMm)) problems.push("label printers need a label width and height in mm");
  if (!p.connection?.host || !Number.isInteger(p.connection.port) || p.connection.port < 1 || p.connection.port > 65535) problems.push("connection needs a host and a port");
  if (p.widthChars !== undefined && ![32, 42, 48].includes(p.widthChars)) problems.push("widthChars must be 32, 42 or 48");
  return problems;
}

export interface Job {
  id: string;
  printerId: string;
  docType: DocType;
  orderId: string | null;
  attempts: number;
  payload: Buffer;
  status: string;
  lastError: string | null;
}

interface EnqueueCtx {
  catalog: Catalog;
  config: BusinessConfig;
  print: PrintContext;
}

const enc = (p: Printer, doc: Doc): Buffer => Buffer.from(encodeEscPos(doc, { widthChars: p.widthChars, drawer: p.drawer }));
const encLabel = (p: Printer, l: Label): Buffer =>
  Buffer.from(p.language === "zpl" ? encodeZpl(l, { dpi: p.dpi }) : encodeEpl(l, { dpi: p.dpi }), "ascii");

/**
 * The print queue for one merchant. Jobs are written once (deduplicated by key) and then moved
 * through leased → done/failed by a delivery agent. Nothing is lost if the printer is off: the job
 * stays queued and is retried with growing delays until it succeeds or runs out of attempts.
 */
export class PrintStore {
  constructor(
    private readonly db: Db,
    private readonly merchantId: string,
  ) {}

  // ---- printers ---------------------------------------------------------------------------

  async listPrinters(): Promise<Printer[]> {
    const r = await this.db.query("SELECT * FROM printers WHERE merchant_id=$1 ORDER BY name", [this.merchantId]);
    return r.rows.map(toPrinter);
  }

  async savePrinter(p: Printer): Promise<void> {
    await this.db.query(
      `INSERT INTO printers (merchant_id,id,name,outlet_id,language,roles,categories,width_chars,drawer,label_width_mm,label_height_mm,dpi,connection,agent_device_id,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (merchant_id,id) DO UPDATE SET name=EXCLUDED.name, outlet_id=EXCLUDED.outlet_id, language=EXCLUDED.language, roles=EXCLUDED.roles,
         categories=EXCLUDED.categories, width_chars=EXCLUDED.width_chars, drawer=EXCLUDED.drawer, label_width_mm=EXCLUDED.label_width_mm,
         label_height_mm=EXCLUDED.label_height_mm, dpi=EXCLUDED.dpi, connection=EXCLUDED.connection, agent_device_id=EXCLUDED.agent_device_id, active=EXCLUDED.active`,
      [this.merchantId, p.id, p.name, p.outletId, p.language, p.roles, p.categories, p.widthChars, p.drawer, p.labelWidthMm, p.labelHeightMm, p.dpi, JSON.stringify(p.connection), p.agentDeviceId, p.active],
    );
  }

  // ---- creating jobs ----------------------------------------------------------------------

  /** Insert a job unless one with this key already exists. Returns whether it was new. */
  private async insertJob(q: Pick<pg.Pool, "query">, p: Printer, docType: DocType, orderId: string | null, key: string, payload: Buffer, title: string | null = null): Promise<boolean> {
    const r = await q.query(
      `INSERT INTO print_jobs (merchant_id,outlet_id,printer_id,doc_type,order_id,dedupe_key,payload,title)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (merchant_id, dedupe_key) DO NOTHING RETURNING 1`,
      [this.merchantId, p.outletId, p.id, docType, orderId, key, payload, title],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Work out what this order needs printed that has not been printed yet, and queue it. Safe to call
   * after every change to the order: receipts go out once, kitchen tickets and labels carry only lines
   * that have not been sent before (so adding to an open tab prints just the additions).
   */
  async enqueueForOrder(order: OrderState, ctx: EnqueueCtx): Promise<number> {
    const printers = (await this.listPrinters()).filter((p) => p.active);
    if (!printers.length || !order.lines.length) return 0;
    const category = new Map(ctx.catalog.products.map((p) => [p.id, p.category]));
    const client = await this.db.connect();
    let made = 0;
    try {
      await client.query("BEGIN");
      // One order at a time, so two events for it arriving together cannot print its lines twice.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`print/${this.merchantId}/${order.orderId}`]);

      if (isFullyPaid(order, ctx.config)) {
        const cash = order.payments.some((x) => x.confirmed && x.method === "cash");
        for (const p of printers.filter((x) => x.roles.includes("receipt"))) {
          const doc = receipt(order, ctx.config, ctx.print);
          if (await this.insertJob(client, p, "receipt", order.orderId, `receipt:${order.orderId}:${p.id}`, enc(p, cash ? withDrawer(doc) : doc), title(order))) made++;
        }
      }

      if (visibleToKitchen(order, ctx.config) && order.stage !== "completed" && order.stage !== "cancelled") {
        for (const docType of ["kitchen", "label"] as const) {
          const targets = printers.filter((x) => x.roles.includes(docType));
          if (!targets.length) continue;
          const sent = new Set((await client.query("SELECT line_id FROM printed_lines WHERE merchant_id=$1 AND order_id=$2 AND doc_type=$3", [this.merchantId, order.orderId, docType])).rows.map((r) => r.line_id as string));
          const fresh = order.lines.filter((l) => l.qty > 0 && !sent.has(l.lineId));
          if (!fresh.length) continue;
          const claimed = new Set<string>();
          const specific = targets.filter((t) => t.categories.length);
          const share = (t: Printer): OrderLine[] =>
            t.categories.length
              ? fresh.filter((l) => t.categories.includes(category.get(l.productId) ?? ""))
              : fresh.filter((l) => !specific.some((s) => s.categories.includes(category.get(l.productId) ?? "")));
          for (const t of targets) {
            const lines = share(t);
            if (!lines.length) continue;
            const key = `${docType}:${order.orderId}:${t.id}:${createHash("sha1").update(lines.map((l) => l.lineId).sort().join(",")).digest("hex").slice(0, 12)}`;
            if (docType === "kitchen") {
              if (await this.insertJob(client, t, "kitchen", order.orderId, key, enc(t, kitchenTicket(order, ctx.print, { lines, addOn: sent.size > 0 })), title(order))) made++;
            } else {
              // one label per unit, in a single job so a roll never gets half an order
              const labels = lines.flatMap((l) => Array.from({ length: l.qty }, () => itemLabel(order, l, ctx.print, { widthMm: t.labelWidthMm ?? 50, heightMm: t.labelHeightMm ?? 30 })));
              const payload = Buffer.concat(labels.map((l) => encLabel(t, l)));
              if (await this.insertJob(client, t, "label", order.orderId, key, payload, title(order))) made++;
            }
            for (const l of lines) claimed.add(l.lineId);
          }
          for (const id of claimed) {
            await client.query("INSERT INTO printed_lines (merchant_id,order_id,line_id,doc_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [this.merchantId, order.orderId, id, docType]);
          }
        }
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    return made;
  }

  /** Print something again on request. Always a new job, never blocked by the original. */
  async reprint(order: OrderState, docType: "receipt" | "kitchen", ctx: EnqueueCtx, printerId?: string): Promise<number> {
    const printers = (await this.listPrinters()).filter((p) => p.active && p.roles.includes(docType) && (!printerId || p.id === printerId));
    let made = 0;
    for (const p of printers) {
      const doc = docType === "receipt" ? receipt(order, ctx.config, ctx.print) : kitchenTicket(order, ctx.print);
      if (await this.insertJob(this.db, p, docType, order.orderId, `reprint:${docType}:${order.orderId}:${p.id}:${Date.now()}:${Math.random()}`, enc(p, doc), title(order) + " (reprint)")) made++;
    }
    return made;
  }

  /** A short page to prove a printer is reachable and set up. */
  async testPage(printerId: string, now: number): Promise<boolean> {
    const p = (await this.listPrinters()).find((x) => x.id === printerId);
    if (!p) return false;
    const stamp = new Date(now).toISOString();
    const payload =
      p.roles.includes("label")
        ? encLabel(p, { widthMm: p.labelWidthMm ?? 50, heightMm: p.labelHeightMm ?? 30, copies: 1, fields: [{ t: "text", xMm: 3, yMm: 3, text: "TEST", heightMm: 8 }, { t: "text", xMm: 3, yMm: 14, text: p.name.slice(0, 26), heightMm: 4 }] })
        : enc(p, { blocks: [{ t: "text", text: "PRINTER TEST", align: "center", bold: true, size: 2 }, { t: "text", text: p.name, align: "center" }, { t: "text", text: stamp, align: "center" }, { t: "feed", n: 3 }, { t: "cut" }] });
    return this.insertJob(this.db, p, "test", null, `test:${p.id}:${now}:${Math.random()}`, payload, "Test page");
  }

  // ---- delivering jobs --------------------------------------------------------------------

  /**
   * Hand a delivery agent the next jobs for its printers, leasing each for a minute. A job whose lease
   * ran out (the agent died mid-print) becomes available again, until it has used up its attempts.
   */
  async claim(agentDeviceId: string, limit = 10): Promise<Array<Job & { printer: Printer }>> {
    await this.db.query(
      `UPDATE print_jobs SET status='failed', last_error=COALESCE(last_error,'') || ' (gave up: agent stopped responding)', updated_at=now()
       WHERE merchant_id=$1 AND status='leased' AND leased_until < now() AND attempts >= $2`,
      [this.merchantId, MAX_ATTEMPTS],
    );
    const r = await this.db.query(
      `UPDATE print_jobs j SET status='leased', leased_until = now() + make_interval(secs => $4), attempts = j.attempts + 1, updated_at = now()
       WHERE j.id IN (
         SELECT j2.id FROM print_jobs j2 JOIN printers p ON p.merchant_id=j2.merchant_id AND p.id=j2.printer_id
         WHERE j2.merchant_id=$1 AND p.active AND (p.agent_device_id IS NULL OR p.agent_device_id=$2)
           AND ((j2.status='queued' AND j2.next_attempt_at <= now()) OR (j2.status='leased' AND j2.leased_until < now() AND j2.attempts < $5))
         ORDER BY j2.created_at LIMIT $3 FOR UPDATE OF j2 SKIP LOCKED)
       RETURNING j.*`,
      [this.merchantId, agentDeviceId, limit, LEASE_SECONDS, MAX_ATTEMPTS],
    );
    const printers = new Map((await this.listPrinters()).map((p) => [p.id, p]));
    return r.rows
      .sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
      .map((row) => ({ ...toJob(row), printer: printers.get(row.printer_id)! }));
  }

  async markDone(jobId: string): Promise<boolean> {
    const r = await this.db.query("UPDATE print_jobs SET status='done', leased_until=NULL, last_error=NULL, updated_at=now() WHERE merchant_id=$1 AND id=$2 AND status='leased'", [this.merchantId, jobId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** The agent could not deliver. Back to the queue with a delay, or failed for good after the last attempt. */
  async markFailed(jobId: string, error: string): Promise<"retry" | "failed" | "unknown"> {
    const r = await this.db.query(
      `UPDATE print_jobs SET
         status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END,
         next_attempt_at = now() + make_interval(secs => LEAST(120, 5 * power(3, GREATEST(0, attempts - 1)))),
         leased_until = NULL, last_error = $4, updated_at = now()
       WHERE merchant_id=$1 AND id=$2 AND status='leased' RETURNING status`,
      [this.merchantId, jobId, MAX_ATTEMPTS, error.slice(0, 300)],
    );
    return r.rows[0] ? (r.rows[0].status === "failed" ? "failed" : "retry") : "unknown";
  }

  async retryFailed(jobId: string): Promise<boolean> {
    const r = await this.db.query("UPDATE print_jobs SET status='queued', attempts=0, next_attempt_at=now(), updated_at=now() WHERE merchant_id=$1 AND id=$2 AND status='failed'", [this.merchantId, jobId]);
    return (r.rowCount ?? 0) > 0;
  }

  async listJobs(status?: string, limit = 100) {
    const r = await this.db.query(
      "SELECT id, printer_id, doc_type, order_id, title, status, attempts, last_error, created_at, updated_at FROM print_jobs WHERE merchant_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT $3",
      [this.merchantId, status ?? null, Math.min(limit, 500)],
    );
    return r.rows;
  }
}

/** What a person sees for a job: the queue number, or a short order id if it has none. */
const title = (o: OrderState) => o.queueNumber ?? `#${o.orderId.slice(0, 6)}`;

const toJob = (r: Record<string, any>): Job => ({
  id: r.id, printerId: r.printer_id, docType: r.doc_type, orderId: r.order_id, attempts: r.attempts, payload: r.payload, status: r.status, lastError: r.last_error,
});
