/**
 * Receipt printers speak single-byte code pages, not Unicode. Everything is reduced to plain ASCII
 * before it is encoded: accents are dropped (é → e), typographic quotes become straight ones, and
 * anything left that a printer cannot show (Chinese, Tamil, emoji…) becomes "?". Printing those
 * scripts needs a printer's CJK mode or an image; it is not done here.
 */
export function toAscii(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?");
}

/** Greedy word wrap to `width` columns; a word longer than a line is split. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of toAscii(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ").filter(Boolean)) {
      let w = word;
      while (w.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!line) line = w;
      else if (line.length + 1 + w.length <= width) line += " " + w;
      else {
        out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

/** Left text and right-aligned text on one line, wrapping the left part when it will not fit. */
export function columns(left: string, right: string, width: number): string[] {
  const r = toAscii(right);
  const room = Math.max(1, width - r.length - 1);
  const parts = wrap(left, room);
  const last = parts.length - 1;
  return parts.map((p, i) => (i === last ? p + " ".repeat(Math.max(1, width - p.length - r.length)) + r : p));
}
