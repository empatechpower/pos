/**
 * A printable document with no printer in mind. Templates build one; an encoder turns it into the
 * bytes for a particular printer language. Width is in characters of the printer's normal font.
 */
export type Block =
  | { t: "text"; text: string; align?: "left" | "center" | "right"; bold?: boolean; size?: 1 | 1.4 | 2 | 3; underline?: boolean }
  | { t: "cols"; left: string; right: string; bold?: boolean }
  | { t: "rule"; ch?: "-" | "=" }
  | { t: "feed"; n: number }
  | { t: "qr"; data: string; size?: number }
  | { t: "barcode"; data: string }
  | { t: "drawer" }
  | { t: "cut" };

export interface Doc {
  blocks: Block[];
}

/** A small sticky label (cup, bag, parcel) laid out in millimetres, so one layout suits any dpi. */
export type LabelField =
  | { t: "text"; xMm: number; yMm: number; text: string; heightMm: number }
  | { t: "qr"; xMm: number; yMm: number; data: string; cellDots?: number }
  | { t: "barcode"; xMm: number; yMm: number; data: string; heightMm: number };

export interface Label {
  widthMm: number;
  heightMm: number;
  copies: number;
  fields: LabelField[];
}

export type PrinterLanguage = "escpos" | "zpl" | "epl";
