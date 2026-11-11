import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import type { Bitmap, RasterRenderer, TextStyle } from "@pos/core";

/**
 * Draws receipt text with real fonts so any script prints. Fonts come from the machine; on a server that has
 * none, point PRINT_FONT_DIR at a folder holding e.g. Noto Sans CJK and Noto Sans Tamil.
 */
if (process.env.PRINT_FONT_DIR) GlobalFonts.loadFontsFromDir(process.env.PRINT_FONT_DIR);

const FAMILY = "Noto Sans CJK SC, Noto Sans Tamil, PingFang SC, Hiragino Sans GB, Heiti SC, Arial Unicode MS, DejaVu Sans, sans-serif";
const BASE_PX = 22; // roughly the height of the printer's own normal font at 203 dpi
const LEADING = 1.25;

const wrapLine = (ctx: { measureText(t: string): { width: number } }, text: string, maxW: number): string[] => {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(/(?<=\s)/)) {
      if (ctx.measureText((cur + word).trimEnd()).width <= maxW) {
        cur += word;
        continue;
      }
      if (cur) lines.push(cur.trimEnd());
      cur = "";
      // A word wider than the line (or a run of CJK with no spaces) is broken by character.
      for (const ch of word) {
        if (ctx.measureText(cur + ch).width > maxW && cur) {
          lines.push(cur);
          cur = "";
        }
        cur += ch;
      }
    }
    lines.push(cur.trimEnd());
  }
  return lines;
};

const toBitmap = (canvas: { getContext(t: "2d"): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } }, w: number, h: number): Bitmap => {
  const d = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const pixels = new Uint8Array(w * h);
  for (let i = 0; i < pixels.length; i++) pixels[i] = d[i * 4]! < 140 ? 1 : 0; // dark enough = black
  return { width: w, height: h, pixels };
};

const font = (px: number, bold?: boolean) => `${bold ? "bold " : ""}${px}px ${FAMILY}`;

export const canvasRenderer: RasterRenderer = {
  text(text, widthPx, style: TextStyle) {
    const px = BASE_PX * (style.size ?? 1);
    const probe = createCanvas(widthPx, 10).getContext("2d");
    probe.font = font(px, style.bold);
    const lines = wrapLine(probe, text, widthPx);
    const lh = Math.ceil(px * LEADING);
    const h = Math.max(1, lines.length * lh);
    const c = createCanvas(widthPx, h);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, widthPx, h);
    g.fillStyle = "#000";
    g.font = font(px, style.bold);
    g.textBaseline = "alphabetic";
    lines.forEach((ln, i) => {
      const w = g.measureText(ln).width;
      const x = style.align === "center" ? (widthPx - w) / 2 : style.align === "right" ? widthPx - w : 0;
      const y = i * lh + px;
      g.fillText(ln, Math.max(0, x), y);
      if (style.underline) g.fillRect(Math.max(0, x), y + 3, w, 2);
    });
    return toBitmap(c, widthPx, h);
  },

  cols(left, right, widthPx, style) {
    const px = BASE_PX;
    const lh = Math.ceil(px * LEADING);
    const probe = createCanvas(widthPx, 10).getContext("2d");
    probe.font = font(px, style.bold);
    const rw = probe.measureText(right).width;
    // A long name wraps onto more lines; the amount stays on the first line and is never cut.
    const lines = wrapLine(probe, left, Math.max(40, widthPx - rw - 12));
    const h = Math.max(1, lines.length) * lh;
    const c = createCanvas(widthPx, h);
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, widthPx, h);
    g.fillStyle = "#000";
    g.font = font(px, style.bold);
    lines.forEach((ln, i) => g.fillText(ln, 0, i * lh + px));
    g.fillText(right, widthPx - rw, px);
    return toBitmap(c, widthPx, h);
  },

  rule(ch, widthPx) {
    const h = 8;
    const px = new Uint8Array(widthPx * h);
    for (let x = 0; x < widthPx; x++) {
      if (ch === "=") {
        px[2 * widthPx + x] = 1;
        px[5 * widthPx + x] = 1;
      } else if (x % 10 < 6) px[3 * widthPx + x] = 1; // dashed
    }
    return { width: widthPx, height: h, pixels: px };
  },
};
