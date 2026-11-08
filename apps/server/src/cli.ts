/**
 * Create the first staff account (or any later one) straight from the terminal:
 *   DATABASE_URL=... npx tsx src/cli.ts create-staff <code> <name> <cashier|manager|owner> <pin>
 *   DATABASE_URL=... npx tsx src/cli.ts enrollment-code
 * prints a one-time code for the very first device. Later codes come from a manager on an enrolled device.
 */
import { PRESETS } from "@pos/core";
import { createStaff, type Role } from "./auth.js";
import { createEnrollmentCode } from "./devices.js";
import { createPool, migrate } from "./db/pool.js";

const [cmd, code, name, role, pin] = process.argv.slice(2);
const usage = () => {
  console.error("usage: DATABASE_URL=... tsx src/cli.ts create-staff <code> <name> <cashier|manager|owner> <pin>\n       DATABASE_URL=... tsx src/cli.ts enrollment-code");
  process.exit(1);
};
if (!process.env.DATABASE_URL) usage();
const mode = (process.env.POS_MODE ?? "fastServe") as keyof typeof PRESETS;
const config = PRESETS[mode]("bailey-patch", "Bailey & Patch", "Enabling Village");
const db = createPool(process.env.DATABASE_URL!);
await migrate(db);
if (cmd === "create-staff" && code && name && role && pin) {
  const s = await createStaff(db, { merchantId: config.businessId, code, name, role: role as Role, pin });
  console.log(`created ${s.role} ${s.name} (${s.code})`);
} else if (cmd === "enrollment-code") {
  const c = await createEnrollmentCode(db, { merchantId: config.businessId, outletId: config.outletName, createdBy: null });
  console.log(`enrollment code: ${c.code}  (one use, expires ${c.expiresAt.toISOString()})`);
} else usage();
await db.end();
