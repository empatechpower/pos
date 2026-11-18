import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrollmentCode, enroll, revokeEnrollmentCodes, REVIEWER_CODE_DAYS, REVIEWER_CODE_USES } from "../src/devices.js";
import { ensureDefaultOutlet } from "../src/tenant.js";
import { startTestDb } from "./pg.js";
import type { Db } from "../src/db/pool.js";

let db: Db;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ db, stop } = await startTestDb());
  await ensureDefaultOutlet(db, "bp", "REVIEW", "App store review");
  await ensureDefaultOutlet(db, "bp", "REAL", "A real shop");
}, 90_000);
afterAll(async () => { await stop(); }, 30_000);

describe("reviewer enrollment code", () => {
  it("lasts weeks, takes many devices, and links only to its own outlet", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "REVIEW", createdBy: null, reviewer: true });
    expect(c.maxUses).toBe(REVIEWER_CODE_USES);
    expect(c.expiresAt.getTime() - Date.now()).toBeGreaterThan((REVIEWER_CODE_DAYS - 1) * 86_400_000);
    const a = await enroll(db, "bp", c.code, "Reviewer 1");
    const b = await enroll(db, "bp", c.code, "Reviewer 2");
    expect(a && b).toBeTruthy();
    expect(a!.device.outletId).toBe("REVIEW");
    expect(b!.device.outletId).toBe("REVIEW");
  });

  it("an ordinary code is still one use and fifteen minutes", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "REAL", createdBy: null });
    expect(c.maxUses).toBe(1);
    expect(c.expiresAt.getTime() - Date.now()).toBeLessThan(16 * 60_000);
  });

  it("can be ended, and an ended code no longer links a device", async () => {
    const c = await createEnrollmentCode(db, { merchantId: "bp", outletId: "REVIEW", createdBy: null, reviewer: true });
    expect(await revokeEnrollmentCodes(db, "bp", "REVIEW")).toBeGreaterThanOrEqual(1);
    expect(await enroll(db, "bp", c.code, "Late")).toBeNull();
  });

  it("ending codes for one outlet leaves another outlet's codes alone", async () => {
    const real = await createEnrollmentCode(db, { merchantId: "bp", outletId: "REAL", createdBy: null });
    await revokeEnrollmentCodes(db, "bp", "REVIEW");
    expect(await enroll(db, "bp", real.code, "Till")).toBeTruthy();
  });
});
