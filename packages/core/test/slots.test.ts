import { describe, it, expect } from "vitest";
import { PRESETS, pickupSlots, isValidSlot, zonedToEpoch, localParts, reduceOrder, visibleToKitchen, shopStatus, type SlotConfig } from "../src/index.js";

const tz = "Asia/Singapore";
const cfgB = PRESETS.restaurant("b1", "Bailey & Patch", "Enabling Village");
const at = (d: string, hm: string) => { const [y, m, dd] = d.split("-").map(Number); const [h, mi] = hm.split(":").map(Number); return zonedToEpoch(y!, m!, dd!, h! * 60 + mi!, tz); };
const base: SlotConfig = { now: at("2026-11-21", "10:07"), timeZone: tz, prepMinutes: 20, intervalMinutes: 15, daysAhead: 3, windows: { menu: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "08:00", end: "21:00" })) } };
const hm = (t: number) => { const l = localParts(t, tz); return `${String(Math.floor(l.minutes / 60)).padStart(2, "0")}:${String(l.minutes % 60).padStart(2, "0")}`; };

describe("pickup slots", () => {
  it("today starts after now plus prep, on the interval", () => {
    const s = pickupSlots("2026-11-21", base);
    expect(hm(s[0]!)).toBe("10:30");
    expect(hm(s[s.length - 1]!)).toBe("20:45");
  });
  it("tomorrow fills the window", () => {
    const s = pickupSlots("2026-11-22", base);
    expect(hm(s[0]!)).toBe("08:00");
    expect(s.every((t: number) => t < at("2026-11-22", "21:00"))).toBe(true);
  });
  it("rejects out-of-window, off-interval, too soon and too far", () => {
    expect(isValidSlot(at("2026-11-22", "07:45"), base)).toBe(false);
    expect(isValidSlot(at("2026-11-22", "09:10"), base)).toBe(false);
    expect(isValidSlot(at("2026-11-21", "10:15"), base)).toBe(false);
    expect(isValidSlot(at("2026-11-26", "12:00"), base)).toBe(false);
    expect(isValidSlot(at("2026-11-22", "12:00"), base)).toBe(true);
  });
  it("an item's own window narrows the slots", () => {
    const cfg: SlotConfig = { ...base, items: [{ id: "b", category: "Breakfast" }], windows: { ...base.windows!, categories: { Breakfast: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "08:00", end: "11:00" })) } } };
    const s = pickupSlots("2026-11-22", cfg);
    expect(hm(s[s.length - 1]!)).toBe("10:45");
  });
});

describe("scheduled orders", () => {
  const opened = { type: "OrderOpened", orderId: "o", fulfilment: "takeaway", source: "online", scheduledFor: 2000, fireAt: 1000 } as any;
  const ev = (body: any, ts: number, seq: number) => ({ id: `e${seq}`, orderId: "o", ts, deviceId: "d", seq, ...body });
  it("is hidden from the kitchen until fired", () => {
    const events = [ev(opened, 1, 1), ev({ type: "ItemAdded", lineId: "l", productId: "p", name: "X", unitCents: 100, qty: 1 }, 2, 2), ev({ type: "OrderAccepted" }, 3, 3)];
    const st = reduceOrder("o", events as any)!;
    expect(st.fireAt).toBe(1000);
    expect(visibleToKitchen(st, cfgB)).toBe(false);
    expect(shopStatus(st, cfgB)).toBe("scheduled");
    const fired = reduceOrder("o", [...events, ev({ type: "OrderFired" }, 1000, 4)] as any)!;
    expect(fired.firedAt).toBe(1000);
    expect(visibleToKitchen(fired, cfgB)).toBe(true);
    expect(shopStatus(fired, cfgB)).toBe("queued");
  });
});
