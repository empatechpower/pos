#!/usr/bin/env node
/**
 * Makes the printable table labels: one QR code and one unique link per table.
 *
 *   node tools/table-labels.mjs https://demo.rezein.com "1-26,31-33" [out-folder]
 *
 * Writes table-labels.html (open it, then print: 6 labels a page, each with its table number, QR code and link)
 * and table-links.csv (the same links, for a spreadsheet or a label printer).
 * The link opens the shop with that table already chosen and locked. Keep the table list the same as the
 * server's SHOP_TABLES setting.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";

const [base, list = "1-26,31-33", out = "table-labels"] = process.argv.slice(2);
if (!base) {
  console.error('Usage: node tools/table-labels.mjs <shop-address> "1-26,31-33" [out-folder]');
  process.exit(1);
}
const origin = base.replace(/\/+$/, "").replace(/^(?!https?:\/\/)/, "https://");
const tables = [];
for (const part of list.split(",").map((x) => x.trim()).filter(Boolean)) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
  if (m) for (let n = Number(m[1]); n <= Number(m[2]); n++) tables.push(n);
  else if (/^\d+$/.test(part)) tables.push(Number(part));
}
const unique = [...new Set(tables)];
mkdirSync(out, { recursive: true });
const link = (n) => `${origin}/#/shop?table=${n}`;

let cards = "";
for (const n of unique) {
  const svg = await QRCode.toString(link(n), { type: "svg", margin: 1, errorCorrectionLevel: "M", width: 220 });
  cards += `<div class="label"><div class="n">Table ${n}</div>${svg}<div class="t">Scan to order</div><div class="u">${link(n)}</div></div>\n`;
}
writeFileSync(
  join(out, "table-labels.html"),
  `<!doctype html><meta charset="utf-8"><title>Table labels</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0}
  .sheet{display:grid;grid-template-columns:repeat(2,1fr);gap:0}
  .label{box-sizing:border-box;height:33.3vh;border:1px dashed #bbb;text-align:center;padding:10px;break-inside:avoid;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .n{font-size:34px;font-weight:800}
  svg{width:170px;height:170px}
  .t{font-size:16px;font-weight:600}
  .u{font-size:9px;color:#666;word-break:break-all}
  @page{size:A4;margin:8mm}
  @media print{.label{height:92mm}}
</style><div class="sheet">\n${cards}</div>`,
);
writeFileSync(join(out, "table-links.csv"), "table,link\n" + unique.map((n) => `Table ${n},${link(n)}`).join("\n") + "\n");
console.log(`Made ${unique.length} labels in ${out}/ (table-labels.html and table-links.csv). Example: ${link(unique[0])}`);
