import { describe, expect, it } from "vitest";
import { parseTables } from "../src/shop.js";

describe("the shop's table list", () => {
  it("turns ranges and single numbers into table names", () => {
    const t = parseTables("1-26,31,32,33");
    expect(t).toHaveLength(29);
    expect(t[0]).toBe("Table 1");
    expect(t[25]).toBe("Table 26");
    expect(t.slice(26)).toEqual(["Table 31", "Table 32", "Table 33"]);
    expect(t).not.toContain("Table 27");
  });
  it("ignores junk, repeats and an unset list", () => {
    expect(parseTables(undefined)).toEqual([]);
    expect(parseTables("")).toEqual([]);
    expect(parseTables("a,5-3, 7 ,7")).toEqual(["Table 7"]);
  });
});
