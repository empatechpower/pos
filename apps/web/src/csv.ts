/** A table as CSV text that Excel and Sheets open correctly: quoted where needed, with a byte-order mark so accents and S$ survive. */
export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const cell = (v: string | number) => {
    const s = String(v);
    // A cell that starts with = + - @ would be run as a formula by a spreadsheet: a leading apostrophe makes it plain text (numbers are left alone).
    const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Dollars with two places, for a spreadsheet (no S$, so it can be added up). */
export const money = (cents: number): string => (cents / 100).toFixed(2);
