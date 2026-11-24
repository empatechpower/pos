import { referenceLooksRight } from "./paynowQr.js";

/** One bank alert email as the mailbox hands it over. */
export interface RawAlert {
  id: string;
  from: string;
  subject: string;
  /** The email's Date header, as sent (second precision). */
  date: string;
  /** The Authentication-Results header(s) the receiving mail server added. */
  authResults: string;
  /** Plain text of the body (HTML already stripped). */
  body: string;
}

export interface ParsedAlert {
  /** The order's reference when the alert carries one (some banks print the QR's remarks); null when the bank leaves it out. */
  reference: string | null;
  /** What the bank printed as remarks, when it prints them. */
  remarks: string | null;
  emailId: string;
  bankRef: string;
  amountCents: number;
  payerName: string;
  accountEnding: string;
  emailDate: number;
  authResults: string;
}

/** DKIM, SPF and DMARC must all say "pass". Anything else (or a missing verdict) never claims an order. */
export function authenticated(authResults: string): boolean {
  const a = authResults.toLowerCase();
  return ["dkim", "spf", "dmarc"].every((k) => new RegExp(`\\b${k}\\s*=\\s*pass\\b`).test(a));
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Reads the alert's body: amount, who paid, the account it landed in, the bank's transaction reference.
 * Written to the field labels the bank prints ("Amount", "From", "Transaction Ref", "account ending"); it is tolerant of
 * wording and spacing, and returns null rather than guess when a field is missing. It has not yet been checked against a real alert.
 */
/**
 * The order's reference inside a bank's text: the 20 characters we put in the QR (RZ, a channel letter, ...), found even if the bank adds spaces or
 * hyphens or changes the case, and only believed when its check character is right. Null when there is none.
 */
export function findReference(text: string): string | null {
  const squashed = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const m of squashed.matchAll(/RZ[OKP][A-Z0-9]{17}/g)) if (referenceLooksRight(m[0])) return m[0];
  return null;
}

/**
 * UOB's "Incoming Funds Received" alert: "Your SGD account ending 0915 received SGD 500.00 on 02 NOV 2026, 16:59. Ref1: ... Ref2: ... Remarks: ...".
 * It has no bank transaction number and no payer name, so the alert is identified by its own email, and the Remarks (which is what we put in the QR) is the match.
 * The seconds come from the email's Date header; the body only has the minute.
 */
export function parseUobAlert(raw: RawAlert): ParsedAlert | null {
  const t = clean(raw.body);
  const acct = /account\s*(?:no\.?\s*)?ending\s*(?:in|with)?\s*[:\-]?\s*(?:x+|\*+)?\s*([0-9]{3,6})\s+received/i.exec(t);
  const amt = /received\s+(?:SGD|S\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(t);
  const rem = /Remarks\s*:\s*([A-Za-z0-9 \-_/]{0,60}?)\s*(?:\.\s|\.$|$|Do not)/i.exec(t);
  const when = Date.parse(raw.date);
  if (!acct || !amt || !/Remarks\s*:/i.test(t) || !Number.isFinite(when)) return null;
  const cents = Math.round(Number(amt[1]!.replace(/,/g, "")) * 100);
  if (!Number.isInteger(cents) || cents <= 0) return null;
  const remarks = clean(rem?.[1] ?? "");
  return { reference: findReference(remarks) ?? findReference(t), remarks: remarks || null, emailId: raw.id, bankRef: `UOB:${raw.id}`, amountCents: cents, payerName: "", accountEnding: acct[1]!, emailDate: when, authResults: raw.authResults.slice(0, 500) };
}

export function parseAlert(raw: RawAlert): ParsedAlert | null {
  const uob = parseUobAlert(raw);
  if (uob) return uob;
  const t = clean(raw.body);
  const amt = /(?:amount|received|sum)[^0-9A-Za-z]{0,12}(?:SGD|S\$|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(t) ?? /(?:SGD|S\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(t);
  const ref = /(?:transaction\s*(?:ref(?:erence)?|id)(?:\s*(?:no\.?|number))?)\s*[:\-]?\s*([A-Za-z0-9]{6,40})/i.exec(t);
  const from = /\bfrom\b\s*[:\-]?\s*([A-Za-z0-9 .,'&\/@-]{2,60}?)(?=\s+(?:to\b|on\b|via\b|transaction\b|amount\b|date\b|reference\b|your\b)|[.]\s|$)/i.exec(t);
  const acct = /account\s*(?:no\.?\s*)?ending\s*(?:in|with)?\s*[:\-]?\s*(?:x+|\*+)?\s*([0-9]{3,6})/i.exec(t);
  const when = Date.parse(raw.date);
  if (!amt || !ref || !acct || !Number.isFinite(when)) return null;
  const cents = Math.round(Number(amt[1]!.replace(/,/g, "")) * 100);
  if (!Number.isInteger(cents) || cents <= 0) return null;
  return { reference: findReference(t), remarks: null, emailId: raw.id, bankRef: ref[1]!, amountCents: cents, payerName: clean(from?.[1] ?? "").slice(0, 80), accountEnding: acct[1]!, emailDate: when, authResults: raw.authResults.slice(0, 500) };
}
