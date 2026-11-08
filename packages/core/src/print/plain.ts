import type { Doc } from "./doc.js";
import { columns, wrap } from "./text.js";

/** The document as plain lines at a given width: what a print preview shows, and what tests read. */
export function plainText(doc: Doc, widthChars: number): string[] {
  const out: string[] = [];
  for (const b of doc.blocks) {
    if (b.t === "text") {
      const w = Math.max(1, Math.floor(widthChars / (b.size ?? 1)));
      for (const line of wrap(b.text, w)) {
        const pad = b.align === "center" ? Math.floor((w - line.length) / 2) : b.align === "right" ? w - line.length : 0;
        out.push(" ".repeat(Math.max(0, pad)) + line);
      }
    } else if (b.t === "cols") out.push(...columns(b.left, b.right, widthChars));
    else if (b.t === "rule") out.push((b.ch ?? "-").repeat(widthChars));
    else if (b.t === "qr") out.push(`[QR ${b.data}]`);
    else if (b.t === "barcode") out.push(`[BARCODE ${b.data}]`);
  }
  return out;
}
