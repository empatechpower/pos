/**
 * Dynamic PayNow QR (SGQR / EMVCo) for one order: the payload text, its CRC, and the short order reference the payer's
 * bank app and the shop's bank statement show. Pure functions, no I/O. See "Rezein PayNow Dynamic QR Developer Spec v1".
 * The payload is built here, on the server, and never from text typed into a browser.
 */

export type ProxyType = "mobile" | "nric" | "uen" | "vpa";
export const PROXY_CODE: Record<ProxyType, string> = { mobile: "0", nric: "1", uen: "2", vpa: "3" };

export interface PaynowConfig {
  proxyType: ProxyType;
  proxyValue: string;
  /** Shown to the payer as the payee name (at most 25 characters). */
  displayName: string;
  /** Two characters naming the outlet inside the reference. */
  outletCode: string;
  /** How long a QR stays live on the server, in minutes (3 to 5). */
  ttlMinutes: number;
  /** Last digits of the account the money lands in, as the bank's alert prints them. When set, an alert for another account never claims. */
  receivingAccountEnding?: string;
  /** The bank's alert sender address, e.g. ibanking.alert@dbs.com. Only mail from here is read. */
  alertSender?: string;
  /** The least and most a QR may ask for, in cents. Left out = no limit. */
  minCents?: number;
  maxCents?: number;
}

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/** CRC-16/CCITT-FALSE over the whole payload including the literal "6304". */
export function crc16(s: string): string {
  let crc = 0xffff;
  for (const b of Buffer.from(s, "ascii")) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

const NRIC_WEIGHTS = [2, 7, 6, 5, 4, 3, 2];
function nricOk(v: string): boolean {
  const m = /^([STFGM])(\d{7})([A-Z])$/.exec(v);
  if (!m) return false;
  let sum = [...m[2]!].reduce((a, d, i) => a + Number(d) * NRIC_WEIGHTS[i]!, 0);
  if (m[1] === "T" || m[1] === "G") sum += 4;
  if (m[1] === "M") sum += 3;
  const idx = sum % 11;
  const table = m[1] === "S" || m[1] === "T" ? "JZIHGFEDCBA" : m[1] === "M" ? "KLJNPQRTUWX" : "XWUTRQPNMLK";
  return table[m[1] === "M" ? 10 - idx : idx] === m[3];
}

/** A reason the proxy is not usable, or null when it is. */
export function proxyProblem(type: ProxyType, value: string): string | null {
  if (type === "mobile") return /^\+65[89]\d{7}$/.test(value) ? null : "A mobile proxy is +65 and 8 digits, starting with 8 or 9.";
  if (type === "nric") return nricOk(value) ? null : "That NRIC / FIN does not pass its check letter.";
  if (type === "uen") return /^(\d{8,9}[A-Z]|[TSR]\d{2}[A-Z]{2}\d{4}[A-Z])([A-Z0-9]{3})?$/.test(value) ? null : "That does not look like a UEN (optionally followed by the 3-character PayNow suffix).";
  if (type === "vpa") return /^[A-Za-z0-9._@-]{3,60}$/.test(value) ? null : "That is not a usable VPA.";
  return "Unknown proxy type.";
}

/** Checks and cleans a configuration from the owner. Returns the clean config or what is wrong. */
export function cleanPaynowConfig(raw: unknown): { ok: true; config: PaynowConfig } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const proxyType = String(r.proxyType ?? "") as ProxyType;
  if (!(proxyType in PROXY_CODE)) return { ok: false, error: "proxyType must be mobile, nric, uen or vpa" };
  const proxyValue = String(r.proxyValue ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const bad = proxyProblem(proxyType, proxyType === "vpa" ? String(r.proxyValue ?? "").trim() : proxyValue);
  if (bad) return { ok: false, error: bad };
  const displayName = String(r.displayName ?? "").toUpperCase().replace(/[^A-Z0-9 &.'-]/g, "").trim().slice(0, 25);
  if (!displayName) return { ok: false, error: "displayName is required (at most 25 characters)" };
  const outletCode = String(r.outletCode ?? "").toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(outletCode)) return { ok: false, error: "outletCode must be 2 letters or digits" };
  const ttl = Number(r.ttlMinutes ?? 3);
  if (!Number.isInteger(ttl) || ttl < 3 || ttl > 5) return { ok: false, error: "ttlMinutes must be 3, 4 or 5" };
  const ending = String(r.receivingAccountEnding ?? "").replace(/\D/g, "");
  if (ending && (ending.length < 3 || ending.length > 6)) return { ok: false, error: "receivingAccountEnding is the last 3 to 6 digits of the account" };
  const sender = String(r.alertSender ?? "").trim().toLowerCase();
  if (sender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) return { ok: false, error: "alertSender must be an email address" };
  const lim = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const minCents = lim(r.minCents), maxCents = lim(r.maxCents);
  if ((minCents !== undefined && (!Number.isInteger(minCents) || minCents < 1)) || (maxCents !== undefined && (!Number.isInteger(maxCents) || maxCents < 1))) return { ok: false, error: "minCents and maxCents are whole cents of 1 or more" };
  if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) return { ok: false, error: "The smallest amount cannot be more than the largest" };
  return { ok: true, config: { proxyType, proxyValue: proxyType === "vpa" ? String(r.proxyValue).trim() : proxyValue, displayName, outletCode, ttlMinutes: ttl, ...(ending ? { receivingAccountEnding: ending } : {}), ...(sender ? { alertSender: sender } : {}), ...(minCents !== undefined ? { minCents } : {}), ...(maxCents !== undefined ? { maxCents } : {}) } };
}

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function base36(n: number, width: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error("base36 needs a whole number of zero or more");
  let s = "";
  for (let x = n; x > 0; x = Math.floor(x / 36)) s = B36[x % 36]! + s;
  if (s.length > width) throw new Error("number too large for the reference");
  return s.padStart(width, "0");
}

export type PaynowChannel = "O" | "K" | "P";

/**
 * The reference: RZ + channel + outlet(2) + sequence in base36 (9) + amount in cents in base36 (5) + check character = 20 characters.
 * `seq` is the payment's own sequence number (order ids are not numeric); the stored reference-to-order mapping is the source of truth.
 */
export function buildReference(o: { channel: PaynowChannel; outletCode: string; seq: number; amountCents: number }): string {
  const body = `RZ${o.channel}${o.outletCode}${base36(o.seq, 9)}${base36(o.amountCents, 5)}`;
  return body + checkChar(body);
}
export const checkChar = (body: string) => B36[[...body].reduce((a, c) => a + B36.indexOf(c), 0) % 36]!;
/** True when a typed or scanned reference has the right shape and check character (a failed check means "do not trust this transcription"). */
export const referenceLooksRight = (ref: string) => /^RZ[OKP][A-Z0-9]{2}[0-9A-Z]{14}[0-9A-Z]$/.test(ref) && checkChar(ref.slice(0, 19)) === ref[19];

export const centsText = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
const ymd = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Singapore" }).format(ms).replace(/-/g, "");

/** The QR text. Amount locked, dynamic, with the reference and the issue date as a coarse expiry backstop (the real expiry is enforced by the server). */
export function buildPayload(o: { config: Pick<PaynowConfig, "proxyType" | "proxyValue" | "displayName">; amountCents: number; reference: string; expiryDate?: string }): string {
  if (!Number.isInteger(o.amountCents) || o.amountCents <= 0) throw new Error("amount must be more than zero");
  if (!/^[A-Z0-9]{1,24}$/.test(o.reference)) throw new Error("reference must be 1 to 24 capital letters or digits");
  const proxy = tlv("00", "SG.PAYNOW") + tlv("01", PROXY_CODE[o.config.proxyType]) + tlv("02", o.config.proxyValue) + tlv("03", "0") + (o.expiryDate ? tlv("04", o.expiryDate) : "");
  const body =
    tlv("00", "01") + tlv("01", "12") + tlv("26", proxy) + tlv("52", "0000") + tlv("53", "702") + tlv("54", centsText(o.amountCents)) +
    tlv("58", "SG") + tlv("59", o.config.displayName.slice(0, 25)) + tlv("60", "Singapore") + tlv("62", tlv("01", o.reference)) + "6304";
  return body + crc16(body);
}

export const issueDate = (now: number) => ymd(now);
