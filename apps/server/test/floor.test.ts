import { describe, expect, it } from "vitest";
import { cleanFloor, DEFAULT_FLOOR } from "../src/floor.js";

describe("floor settings", () => {
  it("keeps where a table sits and its shape, keeps them on the screen, and drops what makes no sense", () => {
    const f = cleanFloor({ sections: [{ id: "a", name: "A", tables: [
      { id: "1", name: "T1", shape: "round", x: 40.26, y: 12 },
      { id: "2", name: "T2", shape: "triangle" as never, x: 500, y: -4 },
      { id: "3", name: "T3", x: 10 },
    ] }] }, DEFAULT_FLOOR)!;
    const [a, b, c] = f.sections[0]!.tables;
    expect(a).toMatchObject({ shape: "round", x: 40.3, y: 12 });
    expect(b!.shape).toBeUndefined();
    expect(b).toMatchObject({ x: 92, y: 0 });
    expect(c!.x).toBeUndefined(); // half a position is no position
  });
  it("keeps a clean layout and refuses duplicate table names", () => {
    const ok = cleanFloor({ sections: [{ id: "a", name: " Patio ", tables: [{ id: "1", name: "P1", seats: 2 }, { id: "2", name: " " }] }] }, DEFAULT_FLOOR)!;
    expect(ok.sections[0]).toMatchObject({ name: "Patio", tables: [{ name: "P1", seats: 2 }] });
    expect(cleanFloor({ sections: [{ id: "a", name: "A", tables: [{ id: "1", name: "T1" }, { id: "2", name: "t1" }] }] }, DEFAULT_FLOOR)).toBeNull();
    expect(cleanFloor({ sections: [] }, DEFAULT_FLOOR)).toBeNull();
  });
  it("changes only what is sent", () => {
    const n = cleanFloor({ splitBill: false }, DEFAULT_FLOOR)!;
    expect(n.splitBill).toBe(false);
    expect(n.courses).toBe(true);
    expect(n.sections).toEqual(DEFAULT_FLOOR.sections);
    expect(cleanFloor({ overdueMinutes: 1 }, DEFAULT_FLOOR)).toBeNull();
  });
});
