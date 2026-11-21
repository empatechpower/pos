/**
 * Shop colours from a logo (developer package F-1): the logo comes first and is never recoloured. The most-used colour of the logo becomes the
 * button/header colour, and the next most-used colour of a clearly different hue becomes the highlight. White, black, grey and see-through
 * pixels are ignored, because they are the paper and the outline of a logo, not its colour.
 */

const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

function hsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

export interface BrandColours { primary: string; accent: string }

/** `rgba` is the image's pixels, four bytes each (what a canvas gives). Returns null when the logo has no colour to take (a black-and-white logo). */
export function brandColoursFromPixels(rgba: ArrayLike<number>): BrandColours | null {
  const BINS = 12;
  const bins = Array.from({ length: BINS }, () => ({ weight: 0, r: 0, g: 0, b: 0, h: 0 }));
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const [r, g, b, a] = [rgba[i]!, rgba[i + 1]!, rgba[i + 2]!, rgba[i + 3]!];
    if (a < 200) continue;
    const c = hsl(r, g, b);
    if (c.l > 0.93 || c.l < 0.08 || c.s < 0.22) continue; // paper, outline, grey
    const w = c.s * (1 - Math.abs(2 * c.l - 1) * 0.5); // vivid mid-tones count most
    const bin = bins[Math.min(BINS - 1, Math.floor(c.h / (360 / BINS)))]!;
    bin.weight += w; bin.r += r * w; bin.g += g * w; bin.b += b * w; bin.h += c.h * w;
  }
  const ranked = bins.filter((x) => x.weight > 0).sort((a, b) => b.weight - a.weight);
  const first = ranked[0];
  if (!first) return null;
  const mean = (x: typeof first) => ({ r: x.r / x.weight, g: x.g / x.weight, b: x.b / x.weight, h: x.h / x.weight });
  const p = mean(first);
  const second = ranked.find((x) => x !== first && hueGap(mean(x).h, p.h) >= 40 && x.weight >= first.weight * 0.1);
  if (second) { const a = mean(second); return { primary: hex(p.r, p.g, p.b), accent: hex(a.r, a.g, a.b) }; }
  // One colour only: the highlight is a lighter tone of it, so the two still belong together.
  const light = (v: number) => v + (255 - v) * 0.35;
  return { primary: hex(p.r, p.g, p.b), accent: hex(light(p.r), light(p.g), light(p.b)) };
}
