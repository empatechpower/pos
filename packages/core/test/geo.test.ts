import { describe, expect, it } from "vitest";
import { distanceKm, formatDistance, sortByDistance, validCoordinates } from "../src/index.js";

const EV = { latitude: 1.2965, longitude: 103.8764 }; // Singapore
const JE = { latitude: 1.3329, longitude: 103.7436 }; // Jurong East

describe("distance", () => {
  it("is the great-circle distance", () => {
    expect(distanceKm(EV, EV)).toBe(0);
    expect(distanceKm(EV, JE)).toBeGreaterThan(14);
    expect(distanceKm(EV, JE)).toBeLessThan(16);
    expect(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111.19, 1);
  });
  it("reads well", () => {
    expect(formatDistance(0.45)).toBe("500 m");
    expect(formatDistance(3.24)).toBe("3.2 km");
    expect(formatDistance(12.4)).toBe("12 km");
  });
  it("sorts nearest first and puts shops with no coordinates last, in their own order", () => {
    const stores = [{ id: "far", ...JE }, { id: "none1" }, { id: "near", latitude: 1.2970, longitude: 103.8770 }, { id: "none2", latitude: null, longitude: null }];
    expect(sortByDistance(stores, EV).map((s) => s.id)).toEqual(["near", "far", "none1", "none2"]);
    expect(sortByDistance(stores, EV)[2]!.distanceKm).toBeNull();
  });
  it("checks coordinates", () => {
    expect(validCoordinates(1.3, 103.8)).toBe(true);
    expect(validCoordinates(91, 0)).toBe(false);
    expect(validCoordinates(0, 181)).toBe(false);
    expect(validCoordinates("1", 2)).toBe(false);
    expect(validCoordinates(NaN, 2)).toBe(false);
  });
});
