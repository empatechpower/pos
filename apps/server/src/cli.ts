/**
 * Create the first staff account (or any later one) straight from the terminal:
 *   DATABASE_URL=... npx tsx src/cli.ts create-staff <code> <name> <cashier|manager|owner> <pin> [phone]
 *   DATABASE_URL=... npx tsx src/cli.ts staff-phone <code> <phone|none>
 * (phone is the number that person signs in with, with its country code, e.g. +6591234567)
 *   DATABASE_URL=... npx tsx src/cli.ts enrollment-code [OUTLET-ID] [testing|reviewer]
 *   DATABASE_URL=... npx tsx src/cli.ts revoke-enrollment-codes OUTLET-ID
 *   DATABASE_URL=... SECRETS_KEY=... MAILBOX_PASSWORD=... npx tsx src/cli.ts add-mailbox "<name>" <imap-server> <email-address> [port]
 *   DATABASE_URL=... npx tsx src/cli.ts list-mailboxes
 *   DATABASE_URL=... npx tsx src/cli.ts remove-mailbox <id>
 * (A PayNow alert mailbox is one WE set up, or one a merchant gives us on their own domain for PayNow alerts only. Merchants never enter a mailbox password.)
 * (OUTLET-ID is the short code from Manager > Outlets; left out, the tablet joins the original outlet)
 * prints a one-time code for the very first device. Later codes come from a manager on an enrolled device.
 */
import { PRESETS } from "@pos/core";
import { createStaff, setStaffPhone, type Role } from "./auth.js";
import { createEnrollmentCode, revokeEnrollmentCodes } from "./devices.js";
import { createPool, migrate } from "./db/pool.js";
import { ensureDefaultOutlet } from "./tenant.js";

const [cmd, code, name, role, pin] = process.argv.slice(2);
const extra = process.argv.slice(3);
const usage = () => {
  console.error("usage: DATABASE_URL=... tsx src/cli.ts create-staff <code> <name> <cashier|manager|owner> <pin> [phone]\n       DATABASE_URL=... tsx src/cli.ts staff-phone <code> <phone|none>\n       DATABASE_URL=... tsx src/cli.ts enrollment-code");
  process.exit(1);
};
if (!process.env.DATABASE_URL) usage();
const mode = (process.env.POS_MODE ?? "fastServe") as keyof typeof PRESETS;
const config = PRESETS[mode]("bailey-patch", "Bailey & Patch", "Enabling Village");
const db = createPool(process.env.DATABASE_URL!);
await migrate(db);
await ensureDefaultOutlet(db, config.businessId, config.outletName, config.outletName);
const phoneSaid = (r: "ok" | "invalid" | "taken" | "unknown", who: string, phone: string | null) =>
  r === "ok" ? (phone ? `${who} now signs in with ${phone}` : `${who} no longer has a sign-in phone number`) : r === "taken" ? `that number already belongs to someone else: ${who} was left without it` : r === "invalid" ? "that is not a phone number: give it with the country code, like +6591234567" : `no staff member has the code ${who}`;
if (cmd === "create-staff" && code && name && role && pin) {
  const s = await createStaff(db, { merchantId: config.businessId, code, name, role: role as Role, pin });
  console.log(`created ${s.role} ${s.name} (${s.code})`);
  const phone = process.argv[7];
  if (phone) console.log(phoneSaid(await setStaffPhone(db, config.businessId, s.code, phone), s.code, phone));
} else if (cmd === "staff-phone" && code && name) {
  // code = the staff code, name = the phone number, or "none" to take it away
  const phone = name.toLowerCase() === "none" ? null : name;
  console.log(phoneSaid(await setStaffPhone(db, config.businessId, code, phone), code, phone));
} else if (cmd === "enrollment-code") {
  const testing = extra.includes("testing");
  const reviewer = extra.includes("reviewer");
  const outletId = extra.find((x) => x !== "testing" && x !== "reviewer") ?? config.outletName;
  const known = (await db.query("SELECT 1 FROM outlets WHERE merchant_id=$1 AND id=$2 AND active", [config.businessId, outletId])).rowCount;
  if (!known) {
    console.error(`No open outlet "${outletId}". Add it first under Manager > Outlets.`);
    await db.end();
    process.exit(1);
  }
  const c = await createEnrollmentCode(db, { merchantId: config.businessId, outletId, createdBy: null, testing, reviewer });
  console.log(`for outlet: ${outletId}`);
  console.log(`enrollment code: ${c.code}  (${c.maxUses === 1 ? "one use" : `${c.maxUses} devices`}, expires ${c.expiresAt.toISOString()})`);
} else if (cmd === "add-mailbox" && code && name && role) {
  // code = name of the mailbox, name = the IMAP server, role = its email address, pin = port (default 993). The password comes from the environment, never from the command line.
  const { addMailbox } = await import("./mailboxes.js");
  const m = await addMailbox(db, config.businessId, { label: code, kind: "imap", host: name, port: pin ? Number(pin) : 993, username: role, password: process.env.MAILBOX_PASSWORD });
  console.log(`added mailbox ${m.label} <${m.username}> (id ${m.id}). Merchants point their bank alerts at ${m.username} and choose it in Settings, PayNow.`);
} else if (cmd === "list-mailboxes") {
  const { listMailboxes } = await import("./mailboxes.js");
  for (const m of await listMailboxes(db, config.businessId)) console.log(`${m.id}  ${m.label}  <${m.username}>  ${m.host ?? "gmail"}  ${m.lastError ? `problem: ${m.lastError}` : m.lastOkAt ? "working" : "not tested yet"}`);
} else if (cmd === "remove-mailbox" && code) {
  const { removeMailbox } = await import("./mailboxes.js");
  console.log((await removeMailbox(db, config.businessId, code)) ? "removed" : "no such mailbox");
} else if (cmd === "revoke-enrollment-codes" && code) {
  console.log(`ended ${await revokeEnrollmentCodes(db, config.businessId, code)} open code(s) for outlet ${code}`);
} else usage();
await db.end();
