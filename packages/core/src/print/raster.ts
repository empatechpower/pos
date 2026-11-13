import type { Doc } from "./doc.js";
import { toAscii } from "./text.js";

/**
 * Raster mode (spec C-1): the receipt is drawn as a picture and sent to the printer as a bitmap, so every script
 * (Chinese, Tamil, Malay accents) and the merchant's logo print the same on any ESC/POS printer. The core knows
 * nothing about fonts: whoever calls it supplies a `RasterRenderer`.
 */
export interface Bitmap {
  width: number;
  height: number;
  /** One byte per pixel, 1 = black, 0 = white. Length = width * height. */
  pixels: Uint8Array;
}

export interface TextStyle {
  bold?: boolean;
  size?: 1 | 1.4 | 2 | 3;
  align?: "left" | "center" | "right";
  underline?: boolean;
}

export interface RasterRenderer {
  /** Draw wrapped text across a paper `widthPx` wide. Returns one bitmap exactly that wide. */
  text(text: string, widthPx: number, style: TextStyle): Bitmap;
  /** Draw a left and a right string on one line. */
  cols(left: string, right: string, widthPx: number, style: { bold?: boolean }): Bitmap;
  /** A horizontal rule of a given character, as wide as the paper. */
  rule(ch: "-" | "=", widthPx: number): Bitmap;
}

export interface EscPosRasterOptions {
  /** Printable dots across: 384 for 58 mm, 576 for 80 mm (203 dpi). */
  widthPx: number;
  render: RasterRenderer;
  drawer?: boolean;
}

const ESC = 0x1b;
const GS = 0x1d;

/** Rows per GS v 0 command. Some printers choke on very tall images, so tall ones are sent in bands. */
export const BAND_ROWS = 128;

/** Pack a bitmap into ESC/POS raster bytes (8 pixels per byte, most significant bit = leftmost). */
export function packRows(b: Bitmap, y0: number, rows: number): Uint8Array {
  const bytesPerRow = Math.ceil(b.width / 8);
  const out = new Uint8Array(bytesPerRow * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < b.width; x++) {
      if (b.pixels[(y0 + y) * b.width + x]) out[y * bytesPerRow + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  return out;
}

/** Bytes that print a bitmap: one or more GS v 0 commands. */
export function rasterCommands(b: Bitmap): number[] {
  const out: number[] = [];
  const bytesPerRow = Math.ceil(b.width / 8);
  for (let y = 0; y < b.height; y += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, b.height - y);
    out.push(GS, 0x76, 0x30, 0, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8);
    for (const v of packRows(b, y, rows)) out.push(v);
  }
  return out;
}

/** Encode a document with text drawn as bitmaps. QR codes, barcodes, feeds, the drawer and the cutter stay native commands. */
export function encodeEscPosRaster(doc: Doc, opts: EscPosRasterOptions): Uint8Array {
  const out: number[] = [ESC, 0x40];
  const bytes = (...b: number[]) => void out.push(...b);
  const image = (b: Bitmap) => {
    if (b.height > 0 && b.width > 0) for (const v of rasterCommands(b)) out.push(v);
  };
  let center = false;
  const setCenter = (c: boolean) => {
    if (c !== center) {
      bytes(ESC, 0x61, c ? 1 : 0);
      center = c;
    }
  };

  for (const b of doc.blocks) {
    switch (b.t) {
      case "text":
        setCenter(false); // alignment is drawn into the bitmap, which is as wide as the paper
        image(opts.render.text(b.text, opts.widthPx, { bold: b.bold, size: b.size, align: b.align, underline: b.underline }));
        break;
      case "cols":
        setCenter(false);
        image(opts.render.cols(b.left, b.right, opts.widthPx, { bold: b.bold }));
        break;
      case "rule":
        setCenter(false);
        image(opts.render.rule(b.ch ?? "-", opts.widthPx));
        break;
      case "feed":
        bytes(ESC, 0x64, Math.min(255, Math.max(0, b.n)));
        break;
      case "qr": {
        setCenter(true);
        const data = toAscii(b.data);
        const len = data.length + 3;
        bytes(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0);
        bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, Math.min(16, Math.max(1, b.size ?? 6)));
        bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31);
        bytes(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30);
        for (const ch of data) out.push(ch.charCodeAt(0));
        bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30, 0x0a);
        break;
      }
      case "barcode": {
        setCenter(true);
        const data = "{B" + toAscii(b.data);
        bytes(GS, 0x68, 60, GS, 0x77, 2, GS, 0x48, 2, GS, 0x6b, 0x49, data.length);
        for (const ch of data) out.push(ch.charCodeAt(0));
        bytes(0x0a);
        break;
      }
      case "drawer":
        if (opts.drawer !== false) bytes(ESC, 0x70, 0, 60, 120);
        break;
      case "cut":
        setCenter(false);
        bytes(GS, 0x56, 0x42, 3);
        break;
    }
  }
  return Uint8Array.from(out);
}
