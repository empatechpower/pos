/**
 * A table as a PDF file, made here in the browser with nothing added to the app: A4 landscape, the report's title and dates at the top,
 * a header row repeated on every page, numbers lined up on the right, and "Page x of y" at the foot. It uses the fonts every PDF reader
 * already has (Courier), so letters outside Western European print as "?".
 */
export interface PdfTable {
  title: string;
  subtitle?: string;
  /** The first row is the header. */
  rows: ReadonlyArray<ReadonlyArray<string | number>>;
}

const PAGE_W = 842, PAGE_H = 595, MARGIN = 36;
const CHAR = 0.6; // a Courier letter is 0.6 of the font size wide
const MAX_COL = 44;

const isNumber = (v: string | number) => typeof v === "number" || /^-?\d[\d,]*(\.\d+)?%?$/.test(v.trim());
/** Text as a PDF string in the standard Latin encoding. */
const pdfText = (s: string) => `(${[...s].map((c) => { const n = c.charCodeAt(0); return n > 255 || n < 32 ? "?" : c === "\\" || c === "(" || c === ")" ? `\\${c}` : c; }).join("")})`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 2))}..` : s);

export function tablePdf(t: PdfTable): Uint8Array {
  const header = (t.rows[0] ?? []).map(String);
  const body = t.rows.slice(1).map((r) => header.map((_, i) => r[i] ?? ""));
  const cols = header.length || 1;
  // Each column is as wide as its longest cell, up to a limit; a column is right-aligned when everything under its heading is a number.
  const width = header.map((h, i) => Math.min(MAX_COL, Math.max(h.length, ...body.map((r) => String(r[i]).length))));
  const right = header.map((_, i) => body.length > 0 && body.every((r) => String(r[i]) === "" || isNumber(r[i]!)));
  const chars = width.reduce((n, w) => n + w, 0) + (cols - 1) * 2;
  const size = Math.max(5, Math.min(9, (PAGE_W - MARGIN * 2) / (chars * CHAR)));
  const lineH = size * 1.45;
  const top = PAGE_H - MARGIN - 34 - (t.subtitle ? 12 : 0);
  const perPage = Math.max(1, Math.floor((top - MARGIN - 14) / lineH) - 1);
  const cell = (v: string | number, i: number) => { const s = clip(String(v), width[i]!); return right[i] ? s.padStart(width[i]!) : s.padEnd(width[i]!); };
  const line = (r: ReadonlyArray<string | number>) => r.map(cell).join("  ");
  const pages: string[][] = [];
  for (let i = 0; i < Math.max(1, body.length); i += perPage) pages.push(body.slice(i, i + perPage).map(line));

  const made = new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });
  const streams = pages.map((rows, p) => {
    const out = ["BT", `/F2 14 Tf ${MARGIN} ${PAGE_H - MARGIN - 12} Td ${pdfText(t.title)} Tj`, "ET"];
    if (t.subtitle) out.push("BT", `/F1 9 Tf ${MARGIN} ${PAGE_H - MARGIN - 28} Td ${pdfText(t.subtitle)} Tj`, "ET");
    out.push("BT", `/F2 ${size.toFixed(2)} Tf ${MARGIN} ${top.toFixed(2)} Td ${pdfText(line(header))} Tj`, "ET");
    out.push(`0.6 w ${MARGIN} ${(top - 3).toFixed(2)} m ${PAGE_W - MARGIN} ${(top - 3).toFixed(2)} l S`);
    out.push("BT", `/F1 ${size.toFixed(2)} Tf ${lineH.toFixed(2)} TL ${MARGIN} ${(top - lineH).toFixed(2)} Td`);
    for (const r of rows) out.push(`${pdfText(r)} Tj T*`);
    if (!body.length) out.push(`${pdfText("Nothing to show for these dates.")} Tj`);
    out.push("ET", "BT", `/F1 8 Tf ${MARGIN} ${MARGIN - 14} Td ${pdfText(`Made ${made} - Page ${p + 1} of ${pages.length}`)} Tj`, "ET");
    return out.join("\n");
  });

  // Objects: 1 catalog, 2 page list, 3 and 4 the two fonts, then a page and its content for each page.
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  streams.forEach((s, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`);
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is one byte (anything else became "?"), so the offsets above are byte offsets.
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

export function downloadBytes(filename: string, bytes: Uint8Array, type = "application/pdf"): void {
  const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
