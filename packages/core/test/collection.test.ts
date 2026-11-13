import { describe, expect, it } from "vitest";
import { collectionNumber } from "../src/index.js";

describe("collectionNumber (spec 11.2, shortened to the last 3 digits)", () => {
  it("is the last 3 digits of the phone, no prefix", () => {
    expect(collectionNumber("+65 9678 1234", new Set())).toBe("234");
    expect(collectionNumber("33336666", new Set())).toBe("666");
  });
  it("adds A, B... from the set actually in use; first free wins", () => {
    expect(collectionNumber("33336666", new Set(["666"]))).toBe("666A");
    expect(collectionNumber("33336666", new Set(["666", "666A"]))).toBe("666B");
    expect(collectionNumber("33336666", new Set(["666", "666B"]))).toBe("666A");
  });
  it("reuses a freed base number", () => {
    expect(collectionNumber("33336666", new Set(["666A"]))).toBe("666");
  });
  it("the seeded example: an active 567 gives 567A", () => {
    expect(collectionNumber("+65 8123 4567", new Set(["567"]))).toBe("567A");
  });
  it("needs a phone number of at least 8 digits", () => {
    expect(collectionNumber(undefined, new Set())).toBeUndefined();
    expect(collectionNumber("1234567", new Set())).toBeUndefined();
  });
});
