import { describe, expect, it } from "vitest";
import { collectionNumber } from "../src/index.js";

describe("collectionNumber (spec 11.2, the last 4 digits so people answer to their phone number)", () => {
  it("is the last 4 digits of the phone, no prefix", () => {
    expect(collectionNumber("+65 9678 1234", new Set())).toBe("1234");
    expect(collectionNumber("33336666", new Set())).toBe("6666");
    expect(collectionNumber("+65 9179 6997", new Set())).toBe("6997");
  });
  it("adds A, B... from the set actually in use; first free wins", () => {
    expect(collectionNumber("33336666", new Set(["6666"]))).toBe("6666A");
    expect(collectionNumber("33336666", new Set(["6666", "6666A"]))).toBe("6666B");
    expect(collectionNumber("33336666", new Set(["6666", "6666B"]))).toBe("6666A");
  });
  it("reuses a freed base number", () => {
    expect(collectionNumber("33336666", new Set(["6666A"]))).toBe("6666");
  });
  it("the seeded example: an active 4567 gives 4567A", () => {
    expect(collectionNumber("+65 8123 4567", new Set(["4567"]))).toBe("4567A");
  });
  it("needs a phone number of at least 8 digits", () => {
    expect(collectionNumber(undefined, new Set())).toBeUndefined();
    expect(collectionNumber("1234567", new Set())).toBeUndefined();
  });
});
