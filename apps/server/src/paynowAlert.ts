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
export function parseAlert(raw: RawAlert): ParsedAlert | null {
  const t = clean(raw.body);
  const amt = /(?:amount|received|sum)[^0-9A-Za-z]{0,12}(?:SGD|S\$|\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(t) ?? /(?:SGD|S\$)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(t);
  const ref = /(?:transaction\s*(?:ref(?:erence)?|id)(?:\s*(?:no\.?|number))?)\s*[:\-]?\s*([A-Za-z0-9]{6,40})/i.exec(t);
  const from = /\bfrom\b\s*[:\-]?\s*([A-Za-z0-9 .,'&\/@-]{2,60}?)(?=\s+(?:to\b|on\b|via\b|transaction\b|amount\b|date\b|reference\b|your\b)|[.]\s|$)/i.exec(t);
  const acct = /account\s*(?:no\.?\s*)?ending\s*(?:in|with)?\s*[:\-]?\s*(?:x+|\*+)?\s*([0-9]{3,6})/i.exec(t);
  const when = Date.parse(raw.date);
  if (!amt || !ref || !acct || !Number.isFinite(when)) return null;
  const cents = Math.round(Number(amt[1]!.replace(/,/g, "")) * 100);
  if (!Number.isInteger(cents) || cents <= 0) return null;
  return { emailId: raw.id, bankRef: ref[1]!, amountCents: cents, payerName: clean(from?.[1] ?? "").slice(0, 80), accountEnding: acct[1]!, emailDate: when, authResults: raw.authResults.slice(0, 500) };
}
