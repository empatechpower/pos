import type { Db } from "./db/pool.js";
import type { ImapFactory } from "./imapMailbox.js";
import { openMailbox } from "./mailboxes.js";
import { allPaynowConfigs } from "./paynow.js";
import type { AlertMailbox, WatchTarget } from "./paynowMatcher.js";

/**
 * Which mailboxes to read, and which PayNow setups each one serves. A setup names its saved mailbox; one that names none uses the server's own
 * (the Gmail in its environment), when there is one. Setups that share a mailbox are read together, so it is looked at once.
 */
export function watchTargets(db: Db, merchantId: string, o: { defaultMailbox: AlertMailbox | null; imapFactory?: ImapFactory; env?: NodeJS.ProcessEnv }): () => Promise<WatchTarget[]> {
  // A saved mailbox is opened once and reused (a Gmail login keeps its short-lived token), until it is edited.
  const opened = new Map<string, { stamp: string; mailbox: AlertMailbox | null }>();
  return async () => {
    const groups = new Map<string, WatchTarget>();
    for (const { config } of await allPaynowConfigs(db, merchantId, o.env)) {
      const key = config.mailboxId ?? "default";
      let t = groups.get(key);
      if (!t) {
        let mailbox: AlertMailbox | null = null;
        if (key === "default") mailbox = o.defaultMailbox;
        else {
          const stamp = String((await db.query("SELECT updated_at::text AS u FROM mailboxes WHERE merchant_id=$1 AND id=$2", [merchantId, key])).rows[0]?.u ?? "");
          const hit = opened.get(key);
          if (hit && hit.stamp === stamp) mailbox = hit.mailbox;
          else { mailbox = stamp ? await openMailbox(db, merchantId, key, o.imapFactory, o.env) : null; opened.set(key, { stamp, mailbox }); }
        }
        if (!mailbox) continue;
        t = { key, mailbox, configs: [] };
        groups.set(key, t);
      }
      t.configs.push(config);
    }
    return [...groups.values()];
  };
}
