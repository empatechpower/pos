import { describe, expect, it } from "vitest";
import { brandColoursFromPixels } from "../src/index.js";

const px = (...cols: Array<[number, number, number, number?, number?]>) => cols.flatMap(([r, g, b, a = 255, n = 1]) => Array.from({ length: n }).flatMap(() => [r, g, b, a]));

describe("shop colours from a logo", () => {
  it("takes the most-used colour as the main one and a clearly different one as the highlight, ignoring white, black and grey", () => {
    const logo = px([255, 255, 255, 255, 500], [0, 0, 0, 255, 200], [128, 128, 128, 255, 100], [225, 82, 62, 255, 300], [20, 60, 160, 255, 120]);
    const c = brandColoursFromPixels(logo)!;
    expect(c.primary).toBe("#e1523e");
    expect(c.accent).toBe("#143ca0");
  });
  it("ignores see-through pixels", () => {
    expect(brandColoursFromPixels(px([225, 82, 62, 0, 1000], [20, 60, 160, 255, 10]))!.primary).toBe("#143ca0");
  });
  it("with one colour, the highlight is a lighter tone of it", () => {
    const c = brandColoursFromPixels(px([225, 82, 62, 255, 100], [255, 255, 255, 255, 100]))!;
    expect(c.primary).toBe("#e1523e");
    expect(c.accent).not.toBe(c.primary);
    expect(parseInt(c.accent.slice(1, 3), 16)).toBeGreaterThan(0xe1);
  });
  it("a black and white logo has no colour to take", () => {
    expect(brandColoursFromPixels(px([0, 0, 0, 255, 100], [255, 255, 255, 255, 100]))).toBeNull();
  });
});
