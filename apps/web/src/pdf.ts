/**
 * A table as a PDF file, made here in the browser with nothing added to the app: A4 landscape, the report's title and dates at the top,
 * a header row repeated on every page, numbers lined up on the right, and "Page x of y" at the foot. Western European text uses the font
 * every PDF reader already has (Courier), so it stays text that can be searched and copied. A table with any other letters (Chinese, Thai,
 * Tamil, ...) is drawn page by page with this device's own fonts and each page is put in the PDF as a picture, so every name prints as written.
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

/** True when every letter fits the PDF's built-in Latin font. */
const latinOnly = (t: PdfTable) => [t.title, t.subtitle ?? "", ...t.rows.flat().map(String)].every((s) => ![...s].some((c) => c.charCodeAt(0) > 255));
const madeAt = () => new Date().toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" });

export function tablePdf(t: PdfTable): Uint8Array {
  if (!latinOnly(t) && typeof document !== "undefined") { const pics = pagePictures(t); if (pics) return assemble(pics.map((pic) => ({ pic }))); }
  return assemble(textPages(t).map((text) => ({ text })));
}

function textPages(t: PdfTable): string[] {
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

  const made = madeAt();
  return pages.map((rows, p) => {
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
}

/** A page drawn on a canvas, as JPEG bytes (one character per byte) and its size in pixels. */
interface Picture { jpeg: string; w: number; h: number }
const SCALE = 2.5; // pixels per PDF point: sharp when printed

function pagePictures(t: PdfTable): Picture[] | null {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return null;
  const FONT = 'system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif';
  const font = (size: number, bold = false) => `${bold ? "bold " : ""}${size}px ${FONT}`;
  const header = (t.rows[0] ?? []).map(String);
  const body = t.rows.slice(1).map((r) => header.map((_, i) => String(r[i] ?? "")));
  const right = header.map((_, i) => body.length > 0 && body.every((r) => r[i] === "" || isNumber(r[i]!)));
  // Column widths measured at size 10, then the size chosen so the table fits the page width (between 5 and 9).
  const measure = (s: string, size: number, bold = false) => { probe.font = font(size, bold); return probe.measureText(s).width; };
  const cap = measure("0", 10) * MAX_COL;
  const w10 = header.map((h, i) => Math.min(cap, Math.max(measure(h, 10, true), ...body.map((r) => measure(r[i]!, 10)))));
  const gap10 = measure("0", 10) * 2;
  const total10 = w10.reduce((n, w) => n + w, 0) + gap10 * (header.length - 1);
  const size = Math.max(5, Math.min(9, (10 * (PAGE_W - MARGIN * 2)) / Math.max(1, total10)));
  // Measured again at the size used (text does not shrink exactly in proportion), with a hair to spare.
  const capS = measure("0", size) * MAX_COL;
  const widths = header.map((h, i) => Math.min(capS, Math.max(measure(h, size, true), ...body.map((r) => measure(r[i]!, size)))) + 0.5), gap = measure("0", size) * 2;
  const lineH = size * 1.45;
  const top = MARGIN + 34 + (t.subtitle ? 12 : 0); // measured from the top of the page here
  const perPage = Math.max(1, Math.floor((PAGE_H - top - MARGIN - 14) / lineH) - 1);
  const pages: string[][][] = [];
  for (let i = 0; i < Math.max(1, body.length); i += perPage) pages.push(body.slice(i, i + perPage));
  const made = madeAt();
  const out: Picture[] = [];
  for (let p = 0; p < pages.length; p++) {
    const c = document.createElement("canvas");
    c.width = Math.round(PAGE_W * SCALE); c.height = Math.round(PAGE_H * SCALE);
    const g = c.getContext("2d");
    if (!g) return null;
    g.scale(SCALE, SCALE);
    g.fillStyle = "#fff"; g.fillRect(0, 0, PAGE_W, PAGE_H);
    g.fillStyle = "#000"; g.textBaseline = "alphabetic";
    const fit = (s: string, w: number) => { if (g.measureText(s).width <= w) return s; let n = s.length; while (n > 1 && g.measureText(`${s.slice(0, n)}..`).width > w) n--; return `${s.slice(0, n)}..`; };
    const row = (cells: string[], y: number, bold: boolean) => {
      g.font = font(size, bold);
      let x = MARGIN;
      cells.forEach((v, i) => { const s = fit(v, widths[i]!); g.textAlign = right[i] ? "right" : "left"; g.fillText(s, right[i] ? x + widths[i]! : x, y); x += widths[i]! + gap; });
      g.textAlign = "left";
    };
    g.font = font(14, true); g.fillText(t.title, MARGIN, MARGIN + 12);
    if (t.subtitle) { g.font = font(9); g.fillText(t.subtitle, MARGIN, MARGIN + 28); }
    row(header, top, true);
    g.lineWidth = 0.6; g.beginPath(); g.moveTo(MARGIN, top + 3); g.lineTo(PAGE_W - MARGIN, top + 3); g.stroke();
    pages[p]!.forEach((r, i) => row(r, top + lineH * (i + 1), false));
    if (!body.length) { g.font = font(size); g.fillText("Nothing to show for these dates.", MARGIN, top + lineH); }
    g.font = font(8); g.fillText(`Made ${made} - Page ${p + 1} of ${pages.length}`, MARGIN, PAGE_H - MARGIN + 14);
    out.push({ jpeg: atob(c.toDataURL("image/jpeg", 0.9).split(",")[1] ?? ""), w: c.width, h: c.height });
  }
  return out;
}

/** The PDF file around the pages: each page is either text in the built-in fonts or one picture filling the page. */
function assemble(pages: Array<{ text: string; pic?: undefined } | { pic: Picture; text?: undefined }>): Uint8Array {
  // Objects: 1 catalog, 2 page list, 3 and 4 the two fonts, then for each page: the page, its content, and its picture (or an empty slot).
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 3} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  pages.forEach((pg, i) => {
    const me = 5 + i * 3;
    const content = pg.pic ? `q ${PAGE_W} 0 0 ${PAGE_H} 0 0 cm /Im1 Do Q` : pg.text;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${pg.pic ? ` /XObject << /Im1 ${me + 2} 0 R >>` : ""} >> /Contents ${me + 1} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    objs.push(pg.pic ? `<< /Type /XObject /Subtype /Image /Width ${pg.pic.w} /Height ${pg.pic.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.pic.jpeg.length} >>\nstream\n${pg.pic.jpeg}\nendstream` : "null");
  });
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is one byte (text outside Latin became "?" or a picture; a picture's bytes are one character each), so the offsets above are byte offsets.
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
