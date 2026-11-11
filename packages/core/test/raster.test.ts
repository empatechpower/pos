import { describe, expect, it } from "vitest";
import { BAND_ROWS, encodeEscPosRaster, packRows, rasterCommands, type Bitmap, type RasterRenderer } from "../src/index.js";

const solid = (w: number, h: number, fill = 1): Bitmap => ({ width: w, height: h, pixels: new Uint8Array(w * h).fill(fill) });
const fake: RasterRenderer = {
  text: (_t, w) => solid(w, 2),
  cols: (_l, _r, w) => solid(w, 2),
  rule: (_c, w) => solid(w, 1),
};

describe("raster packing", () => {
  it("packs 8 pixels per byte, leftmost pixel in the top bit", () => {
    const b: Bitmap = { width: 10, height: 1, pixels: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 1, 1, 0]) };
    expect(Array.from(packRows(b, 0, 1))).toEqual([0b10000001, 0b10000000]);
  });
  it("pads a width that is not a multiple of 8", () => {
    expect(packRows(solid(3, 2), 0, 2)).toHaveLength(2);
    expect(Array.from(packRows(solid(3, 1), 0, 1))).toEqual([0b11100000]);
  });
});

describe("GS v 0 commands", () => {
  it("one band: header, width in bytes, height, then the data", () => {
    const c = rasterCommands(solid(16, 3));
    expect(c.slice(0, 8)).toEqual([0x1d, 0x76, 0x30, 0, 2, 0, 3, 0]);
    expect(c).toHaveLength(8 + 2 * 3);
  });
  it("tall images are sent in bands", () => {
    const c = rasterCommands(solid(8, BAND_ROWS + 5));
    expect(c.filter((v, i) => v === 0x1d && c[i + 1] === 0x76 && c[i + 2] === 0x30)).toHaveLength(2);
  });
});

describe("encodeEscPosRaster", () => {
  const doc = { blocks: [
    { t: "text", text: "咖啡 Kopi தமிழ்", align: "center" },
    { t: "cols", left: "Kopi x2", right: "S$4.40" },
    { t: "rule" },
    { t: "qr", data: "https://x.test/o/1" },
    { t: "drawer" },
    { t: "cut" },
  ] as const };

  it("draws text as bitmaps (no text bytes), keeps QR/drawer/cut native", () => {
    const bytes = Array.from(encodeEscPosRaster({ blocks: [...doc.blocks] }, { widthPx: 384, render: fake }));
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    const gsv0 = bytes.filter((v, i) => v === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30).length;
    expect(gsv0).toBe(3); // text, cols, rule
    expect(bytes.join(",")).toContain([0x1d, 0x28, 0x6b].join(",")); // QR
    expect(bytes.join(",")).toContain([0x1b, 0x70, 0].join(",")); // drawer
    expect(bytes.slice(-4)).toEqual([0x1d, 0x56, 0x42, 3]); // cut
  });
  it("can leave the drawer alone", () => {
    const bytes = Array.from(encodeEscPosRaster({ blocks: [{ t: "drawer" }] }, { widthPx: 384, render: fake, drawer: false }));
    expect(bytes).toEqual([0x1b, 0x40]);
  });
});
