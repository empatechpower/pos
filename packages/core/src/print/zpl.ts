import type { Label } from "./doc.js";
import { toAscii } from "./text.js";

export interface LabelPrinterOptions {
  /** Dots per inch: 203 (8 dots/mm) is the common desktop Zebra, 300 for fine print. */
  dpi: 203 | 300;
}

const dots = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);

/**
 * ^FD data may not contain ^ or ~ (they are command characters). With ^FH, "\\5E" style hex escapes
 * stand in for them, and the backslash itself must be escaped too.
 */
const zplEscape = (s: string) => toAscii(s).replace(/[\\^~]/g, (c) => "\\" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));

/** Encode a label as ZPL II for Zebra printers. */
export function encodeZpl(label: Label, opts: LabelPrinterOptions): string {
  const d = opts.dpi;
  const lines = ["^XA", `^PW${dots(label.widthMm, d)}`, `^LL${dots(label.heightMm, d)}`, "^LH0,0"];
  for (const f of label.fields) {
    const x = dots(f.xMm, d);
    const y = dots(f.yMm, d);
    if (f.t === "text") lines.push(`^FO${x},${y}^A0N,${dots(f.heightMm, d)}^FH\\^FD${zplEscape(f.text)}^FS`);
    else if (f.t === "qr") lines.push(`^FO${x},${y}^BQN,2,${f.cellDots ?? 5}^FH\\^FDMA,${zplEscape(f.data)}^FS`);
    else lines.push(`^FO${x},${y}^BCN,${dots(f.heightMm, d)},Y,N,N^FH\\^FD${zplEscape(f.data)}^FS`);
  }
  lines.push(`^PQ${Math.max(1, label.copies)}`, "^XZ");
  return lines.join("\n") + "\n";
}
