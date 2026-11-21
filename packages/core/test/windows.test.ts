import { describe, expect, it } from "vitest";
import { availabilityOf, evaluateWindows, isTimeZone, lastBoundaryAt, menuState, validateWindows, type MenuWindows } from "../src/index.js";

// Backend handout section 6 and fixture 8. The audited store sold Fri 11:00-20:30 and Sat 11:00-15:30 (Singapore) while "open" all day.
const SG = "Asia/Singapore";
const at = (iso: string) => Date.parse(iso); // iso with +08:00
const FRI = 5, SAT = 6;
const windows: MenuWindows = { menu: [{ day: FRI, start: "11:00", end: "20:30" }, { day: SAT, start: "11:00", end: "15:30" }] };
const bowl = { id: "bowl", category: "Bowls" };

describe("menu time windows", () => {
  it("inside a window an item is ORDERABLE and says when the window closes", () => {
    const a = availabilityOf(bowl, windows, at("2026-11-20T12:00:00+08:00"), SG);
    expect(a).toEqual({ state: "ORDERABLE", closesAt: at("2026-11-20T20:30:00+08:00") });
  });

  it("fixture 8: outside the window it is AVAILABLE_LATER, with the window it belongs to and the next opening", () => {
    const early = availabilityOf(bowl, windows, at("2026-11-20T10:00:00+08:00"), SG);
    expect(early).toMatchObject({ state: "AVAILABLE_LATER", nextOpeningAt: at("2026-11-20T11:00:00+08:00"), window: { day: FRI, start: "11:00", end: "20:30" } });
    // after Friday's close the next opening is Saturday's window
    expect(availabilityOf(bowl, windows, at("2026-11-20T21:00:00+08:00"), SG)).toMatchObject({ state: "AVAILABLE_LATER", nextOpeningAt: at("2026-11-21T11:00:00+08:00"), window: { day: SAT } });
    // after Saturday's close, and all of Sunday to Thursday, it waits for next Friday
    expect(availabilityOf(bowl, windows, at("2026-11-21T16:00:00+08:00"), SG).nextOpeningAt).toBe(at("2026-11-27T11:00:00+08:00"));
    expect(availabilityOf(bowl, windows, at("2026-11-23T09:00:00+08:00"), SG).nextOpeningAt).toBe(at("2026-11-27T11:00:00+08:00"));
    // the exact moments: opens AT 11:00, closed AT 20:30
    expect(availabilityOf(bowl, windows, at("2026-11-20T11:00:00+08:00"), SG).state).toBe("ORDERABLE");
    expect(availabilityOf(bowl, windows, at("2026-11-20T20:30:00+08:00"), SG).state).toBe("AVAILABLE_LATER");
    expect(availabilityOf(bowl, windows, at("2026-11-20T20:29:59+08:00"), SG).state).toBe("ORDERABLE");
  });

  it("the most specific window wins: an item's over its category's over the menu's; none at all means always", () => {
    const w: MenuWindows = { menu: windows.menu, categories: { Breakfast: [{ day: FRI, start: "07:00", end: "10:30" }] }, products: { kaya: [{ day: FRI, start: "00:00", end: "24:00" }] } };
    const noon = at("2026-11-20T12:00:00+08:00");
    expect(availabilityOf({ id: "egg", category: "Breakfast" }, w, noon, SG).state).toBe("AVAILABLE_LATER"); // its category closed at 10:30
    expect(availabilityOf({ id: "kaya", category: "Breakfast" }, w, noon, SG).state).toBe("ORDERABLE"); // its own window is all day
    expect(availabilityOf(bowl, w, noon, SG).state).toBe("ORDERABLE"); // the menu's window
    expect(availabilityOf(bowl, undefined, noon, SG).state).toBe("ORDERABLE");
    expect(availabilityOf(bowl, {}, noon, SG).state).toBe("ORDERABLE");
  });

  it("off beats sold out beats the window", () => {
    const night = at("2026-11-23T03:00:00+08:00");
    expect(availabilityOf({ ...bowl, soldOut: true }, windows, night, SG, true).state).toBe("OFF");
    expect(availabilityOf({ ...bowl, soldOut: true }, windows, night, SG).state).toBe("SOLD_OUT");
    expect(availabilityOf(bowl, windows, night, SG).state).toBe("AVAILABLE_LATER");
  });

  it("a window past midnight belongs to the day it started; back-to-back windows count as one", () => {
    const late: MenuWindows = { menu: [{ day: FRI, start: "18:00", end: "02:00" }] };
    expect(evaluateWindows(late.menu, at("2026-11-21T01:00:00+08:00"), SG)).toMatchObject({ open: true, closesAt: at("2026-11-21T02:00:00+08:00") });
    expect(evaluateWindows(late.menu, at("2026-11-21T02:00:00+08:00"), SG).open).toBe(false);
    const split = [{ day: FRI, start: "11:00", end: "15:00" }, { day: FRI, start: "15:00", end: "20:00" }];
    expect(evaluateWindows(split, at("2026-11-20T12:00:00+08:00"), SG)).toMatchObject({ open: true, closesAt: at("2026-11-20T20:00:00+08:00") });
  });

  it("the menu's own state, for the whole outlet", () => {
    expect(menuState(windows, at("2026-11-20T12:00:00+08:00"), SG).state).toBe("ORDERABLE");
    expect(menuState(windows, at("2026-11-22T12:00:00+08:00"), SG)).toMatchObject({ state: "AVAILABLE_LATER", nextOpeningAt: at("2026-11-27T11:00:00+08:00") });
    expect(menuState(undefined, at("2026-11-22T12:00:00+08:00"), SG).state).toBe("ORDERABLE");
  });

  it("a boundary stamp stands still between boundaries and moves exactly at each one, so the menu version flips by itself", () => {
    const stamp = (iso: string) => lastBoundaryAt(windows, at(iso), SG);
    expect(stamp("2026-11-20T10:59:59+08:00")).not.toBe(stamp("2026-11-20T11:00:00+08:00")); // the window opens
    expect(stamp("2026-11-20T11:00:00+08:00")).toBe(at("2026-11-20T11:00:00+08:00"));
    expect(stamp("2026-11-20T11:00:00+08:00")).toBe(stamp("2026-11-20T20:29:59+08:00")); // nothing moves while it is open
    expect(stamp("2026-11-20T20:30:00+08:00")).toBe(at("2026-11-20T20:30:00+08:00")); // it closes
    expect(stamp("2026-11-20T20:30:00+08:00")).toBe(stamp("2026-11-21T10:59:00+08:00")); // and stays put all night
    expect(stamp("2026-11-21T11:00:00+08:00")).toBeGreaterThan(stamp("2026-11-20T20:30:00+08:00"));
    expect(lastBoundaryAt(undefined, at("2026-11-20T12:00:00+08:00"), SG)).toBe(0);
    expect(lastBoundaryAt({}, at("2026-11-20T12:00:00+08:00"), SG)).toBe(0);
  });

  it("windows follow the outlet's own clock, daylight saving included", () => {
    const ny: MenuWindows = { menu: [{ day: 0, start: "09:00", end: "10:00" }] }; // Sunday 1 Nov 2026: US clocks go back at 2am
    const before = Date.parse("2026-11-01T13:59:00Z"); // 08:59 in New York (EST, UTC-5)
    expect(menuState(ny, before, "America/New_York")).toMatchObject({ state: "AVAILABLE_LATER", nextOpeningAt: Date.parse("2026-11-01T14:00:00Z") });
    expect(menuState(ny, Date.parse("2026-11-01T14:00:00Z"), "America/New_York").state).toBe("ORDERABLE");
    // the same instant is another weekday in Singapore
    expect(menuState(ny, Date.parse("2026-11-01T14:00:00Z"), SG).state).toBe("AVAILABLE_LATER");
    expect(isTimeZone("Asia/Singapore")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
  });

  it("checks windows: bad days, bad times, a window that starts and ends together", () => {
    expect(validateWindows(windows)).toEqual([]);
    expect(validateWindows({ menu: [{ day: 7, start: "11:00", end: "12:00" }] }).join()).toContain("day must be");
    expect(validateWindows({ menu: [{ day: 1, start: "9am", end: "12:00" }] }).join()).toContain("HH:MM");
    expect(validateWindows({ menu: [{ day: 1, start: "24:00", end: "12:00" }] }).join()).toContain("HH:MM");
    expect(validateWindows({ categories: { Toast: [{ day: 1, start: "10:00", end: "10:00" }] } }).join()).toContain("same time");
    expect(validateWindows({ products: { x: "always" as never } }).join()).toContain("must be a list");
    expect(validateWindows({ menu: [{ day: 1, start: "00:00", end: "24:00" }] })).toEqual([]);
  });
});
