import type { Doc } from "./doc.js";
import { columns, toAscii, wrap } from "./text.js";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export interface EscPosOptions {
  /** Characters per line in the normal font: 32 (58 mm), 42 or 48 (80 mm). */
  widthChars: number;
  /** Pulse the cash drawer when a { t: "drawer" } block is present (default true). */
  drawer?: boolean;
}

/** Encode a document as ESC/POS bytes. Output is deterministic, so it can be asserted byte for byte. */
export function encodeEscPos(doc: Doc, opts: EscPosOptions): Uint8Array {
  const out: number[] = [ESC, 0x40, ESC, 0x74, 0x00]; // initialise; code page 0 (PC437)
  const bytes = (...b: number[]) => void out.push(...b);
  const ascii = (s: string) => {
    for (const ch of s) out.push(ch.charCodeAt(0));
  };
  let align: "left" | "center" | "right" = "left";
  const setAlign = (a: typeof align) => {
    if (a !== align) {
      bytes(ESC, 0x61, a === "left" ? 0 : a === "center" ? 1 : 2);
      align = a;
    }
  };

  for (const b of doc.blocks) {
    switch (b.t) {
      case "text": {
        const size = b.size ?? 1;
        setAlign(b.align ?? "left");
        bytes(ESC, 0x45, b.bold ? 1 : 0, ESC, 0x2d, b.underline ? 1 : 0, GS, 0x21, ((size - 1) << 4) | (size - 1));
        // A double-width character takes two columns, so wrap to the narrower line.
        for (const line of wrap(b.text, Math.max(1, Math.floor(opts.widthChars / size)))) {
          ascii(line);
          bytes(LF);
        }
        bytes(GS, 0x21, 0, ESC, 0x45, 0, ESC, 0x2d, 0);
        break;
      }
      case "cols": {
        setAlign("left");
        bytes(ESC, 0x45, b.bold ? 1 : 0);
        for (const line of columns(b.left, b.right, opts.widthChars)) {
          ascii(line);
          bytes(LF);
        }
        bytes(ESC, 0x45, 0);
        break;
      }
      case "rule":
        setAlign("left");
        ascii((b.ch ?? "-").repeat(opts.widthChars));
        bytes(LF);
        break;
      case "feed":
        bytes(ESC, 0x64, Math.min(255, Math.max(0, b.n)));
        break;
      case "qr": {
        setAlign("center");
        const data = toAscii(b.data);
        const len = data.length + 3;
        bytes(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0); // model 2
        bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, Math.min(16, Math.max(1, b.size ?? 6))); // module size
        bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // error correction M
        bytes(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30);
        ascii(data);
        bytes(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // print
        bytes(LF);
        break;
      }
      case "barcode": {
        setAlign("center");
        const data = "{B" + toAscii(b.data); // Code 128, subset B
        bytes(GS, 0x68, 60, GS, 0x77, 2, GS, 0x48, 2); // height, width, text below
        bytes(GS, 0x6b, 0x49, data.length);
        ascii(data);
        bytes(LF);
        break;
      }
      case "drawer":
        if (opts.drawer !== false) bytes(ESC, 0x70, 0, 60, 120);
        break;
      case "cut":
        setAlign("left");
        bytes(GS, 0x56, 0x42, 3); // feed to the cutter, then partial cut
        break;
    }
  }
  return Uint8Array.from(out);
}
