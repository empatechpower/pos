import type { Label } from "./doc.js";
import { toAscii } from "./text.js";
import type { LabelPrinterOptions } from "./zpl.js";

const dots = (mm: number, dpi: number) => Math.round((mm * dpi) / 25.4);
/** EPL strings are quoted; inside them only " and \ need a backslash. */
const eplEscape = (s: string) => toAscii(s).replace(/[\\"]/g, (c) => "\\" + c);

/**
 * Encode a label as EPL2, for older Zebra/Eltron printers that do not speak ZPL. Text uses the
 * printer's built-in fonts, picked by height: they come in fixed sizes, so the nearest one is used.
 */
export function encodeEpl(label: Label, opts: LabelPrinterOptions): string {
  const d = opts.dpi;
  // Built-in font 1..5 heights in dots at 203 dpi: 12, 16, 20, 24, 32. Scale for 300 dpi.
  const fonts: Array<[number, number]> = [[1, 12], [2, 16], [3, 20], [4, 24], [5, 32]];
  const fontFor = (heightMm: number) => {
    const want = dots(heightMm, 203);
    return fonts.reduce((best, f) => (Math.abs(f[1] - want) < Math.abs(best[1] - want) ? f : best))[0];
  };
  const lines = ["", "N", `q${dots(label.widthMm, d)}`, `Q${dots(label.heightMm, d)},24`];
  for (const f of label.fields) {
    const x = dots(f.xMm, d);
    const y = dots(f.yMm, d);
    if (f.t === "text") lines.push(`A${x},${y},0,${fontFor(f.heightMm)},1,1,N,"${eplEscape(f.text)}"`);
    else if (f.t === "qr") lines.push(`b${x},${y},Q,m2,s${f.cellDots ?? 5},eM,iA,"${eplEscape(f.data)}"`);
    else lines.push(`B${x},${y},0,1,2,6,${dots(f.heightMm, d)},B,"${eplEscape(f.data)}"`);
  }
  lines.push(`P${Math.max(1, label.copies)}`);
  return lines.join("\n") + "\n";
}
