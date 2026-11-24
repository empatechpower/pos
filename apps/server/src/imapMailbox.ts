import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { RawAlert } from "./paynowAlert.js";
import type { AlertMailbox } from "./paynowMatcher.js";

/** What the reader needs from an IMAP connection. The real one is ImapFlow; tests hand in a stand-in. */
export interface ImapLike {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<{ release(): void }>;
  search(query: { from: string; since: Date }, opts: { uid: true }): Promise<number[] | false>;
  fetch(range: number[], query: { source: true; uid: true }, opts: { uid: true }): AsyncIterable<{ uid: number; source?: Buffer }>;
  logout(): Promise<void>;
}
export interface ImapCred { host: string; port: number; user: string; pass: string }
export type ImapFactory = (c: ImapCred) => ImapLike;

export const realImap: ImapFactory = (c) =>
  new ImapFlow({ host: c.host, port: c.port, secure: c.port === 993, auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: 20_000, greetingTimeout: 15_000, connectionTimeout: 15_000 }) as unknown as ImapLike;

const strip = (h: string) => h.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** One raw email turned into what the matcher reads. Authentication-Results is the receiving server's own verdict on DKIM, SPF and DMARC. */
export async function rawToAlert(source: Buffer, id: string): Promise<RawAlert> {
  const m = await simpleParser(source);
  const auth = m.headers.get("authentication-results");
  const authText = Array.isArray(auth) ? auth.map((x) => (typeof x === "string" ? x : (x as { value?: string }).value ?? "")).join(" ; ") : typeof auth === "string" ? auth : (auth as { value?: string } | undefined)?.value ?? "";
  return { id, from: m.from?.text ?? "", subject: m.subject ?? "", date: m.date ? m.date.toUTCString() : "", authResults: authText, body: m.text?.trim() || (typeof m.html === "string" ? strip(m.html) : "") };
}

/** Reads a merchant's alert mailbox over IMAP (any provider; with Gmail, an app password). Only mail from the bank's sender is fetched, newest few. */
export class ImapMailbox implements AlertMailbox {
  constructor(private cred: ImapCred, private factory: ImapFactory = realImap) {}

  async fetch(o: { sender: string; afterMs: number }): Promise<RawAlert[]> {
    const client = this.factory(this.cred);
    await client.connect();
    const out: RawAlert[] = [];
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = await client.search({ from: o.sender, since: new Date(o.afterMs) }, { uid: true });
        const latest = (uids || []).slice(-50);
        if (latest.length) for await (const msg of client.fetch(latest, { source: true, uid: true }, { uid: true })) if (msg.source) out.push(await rawToAlert(msg.source, `imap:${this.cred.user}:${msg.uid}`));
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    return out;
  }
}
