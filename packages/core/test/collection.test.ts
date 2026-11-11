import { describe, expect, it } from "vitest";
import { collectionNumber } from "../src/index.js";

describe("collectionNumber (spec 11.2)", () => {
  it("is the last 5 digits of the phone, no prefix", () => {
    expect(collectionNumber("+65 9678 1234", new Set())).toBe("81234");
    expect(collectionNumber("33336666", new Set())).toBe("36666");
  });
  it("adds A, B... from the set actually in use; first free wins", () => {
    expect(collectionNumber("33336666", new Set(["36666"]))).toBe("36666A");
    expect(collectionNumber("33336666", new Set(["36666", "36666A"]))).toBe("36666B");
    expect(collectionNumber("33336666", new Set(["36666", "36666B"]))).toBe("36666A");
  });
  it("reuses a freed base number", () => {
    expect(collectionNumber("33336666", new Set(["36666A"]))).toBe("36666");
  });
  it("Alex's seeded fixture: an active 34567 gives 34567A", () => {
    expect(collectionNumber("+65 8123 4567", new Set(["34567"]))).toBe("34567A");
  });
  it("needs at least 8 digits", () => {
    expect(collectionNumber("12345", new Set())).toBeUndefined();
    expect(collectionNumber(undefined, new Set())).toBeUndefined();
  });
});
