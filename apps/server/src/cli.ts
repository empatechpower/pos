/**
 * Create the first staff account (or any later one) straight from the terminal:
 *   DATABASE_URL=... npx tsx src/cli.ts create-staff <code> <name> <cashier|manager|owner> <pin>
 *   DATABASE_URL=... npx tsx src/cli.ts enrollment-code [OUTLET-ID] [testing]
 * (OUTLET-ID is the short code from Manager > Outlets; left out, the tablet joins the original outlet)
 * prints a one-time code for the very first device. Later codes come from a manager on an enrolled device.
 */
import { PRESETS } from "@pos/core";
import { createStaff, type Role } from "./auth.js";
import { createEnrollmentCode } from "./devices.js";
import { createPool, migrate } from "./db/pool.js";
import { ensureDefaultOutlet } from "./tenant.js";

const [cmd, code, name, role, pin] = process.argv.slice(2);
const extra = process.argv.slice(3);
const usage = () => {
  console.error("usage: DATABASE_URL=... tsx src/cli.ts create-staff <code> <name> <cashier|manager|owner> <pin>\n       DATABASE_URL=... tsx src/cli.ts enrollment-code");
  process.exit(1);
};
if (!process.env.DATABASE_URL) usage();
const mode = (process.env.POS_MODE ?? "fastServe") as keyof typeof PRESETS;
const config = PRESETS[mode]("bailey-patch", "Bailey & Patch", "Enabling Village");
const db = createPool(process.env.DATABASE_URL!);
await migrate(db);
await ensureDefaultOutlet(db, config.businessId, config.outletName, config.outletName);
if (cmd === "create-staff" && code && name && role && pin) {
  const s = await createStaff(db, { merchantId: config.businessId, code, name, role: role as Role, pin });
  console.log(`created ${s.role} ${s.name} (${s.code})`);
} else if (cmd === "enrollment-code") {
  const testing = extra.includes("testing");
  const outletId = extra.find((x) => x !== "testing") ?? config.outletName;
  const known = (await db.query("SELECT 1 FROM outlets WHERE merchant_id=$1 AND id=$2 AND active", [config.businessId, outletId])).rowCount;
  if (!known) {
    console.error(`No open outlet "${outletId}". Add it first under Manager > Outlets.`);
    await db.end();
    process.exit(1);
  }
  const c = await createEnrollmentCode(db, { merchantId: config.businessId, outletId, createdBy: null, testing });
  console.log(`for outlet: ${outletId}`);
  console.log(`enrollment code: ${c.code}  (${c.maxUses === 1 ? "one use" : `${c.maxUses} devices`}, expires ${c.expiresAt.toISOString()})`);
} else usage();
await db.end();
