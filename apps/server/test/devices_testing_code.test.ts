import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrollmentCode, enroll } from "../src/devices.js";
import type { Db } from "../src/db/pool.js";
import { startTestDb } from "./pg.js";

let t: { db: Db };
let stop: () => Promise<void>;
beforeAll(async () => {
  const x = await startTestDb();
  t = x;
  stop = x.stop;
}, 120_000);
afterAll(async () => {
  await stop?.();
});

describe("enrolment codes", () => {
  it("an ordinary code works once", async () => {
    const c = await createEnrollmentCode(t.db, { merchantId: "bp", outletId: "EV", createdBy: null });
    expect(c.maxUses).toBe(1);
    expect(await enroll(t.db, "bp", c.code, "A")).not.toBeNull();
    expect(await enroll(t.db, "bp", c.code, "B")).toBeNull();
  });

  it("a testing code enrols many devices, up to its limit, each with its own token", async () => {
    const c = await createEnrollmentCode(t.db, { merchantId: "bp", outletId: "EV", createdBy: null, testing: true });
    expect(c.maxUses).toBe(25);
    const tokens = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const e = await enroll(t.db, "bp", c.code, `Phone ${i}`);
      expect(e).not.toBeNull();
      tokens.add(e!.token);
    }
    expect(tokens.size).toBe(25);
    expect(await enroll(t.db, "bp", c.code, "One too many")).toBeNull();
  });

  it("a re-issue code is never a testing code", async () => {
    const first = await createEnrollmentCode(t.db, { merchantId: "bp", outletId: "EV", createdBy: null });
    const dev = (await enroll(t.db, "bp", first.code, "Till"))!;
    const re = await createEnrollmentCode(t.db, { merchantId: "bp", outletId: "EV", createdBy: null, deviceId: dev.device.id, testing: true });
    expect(re.maxUses).toBe(1);
  });
});
