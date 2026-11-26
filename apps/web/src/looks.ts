/**
 * The till's looks. A look is the whole interface style a person works in, chosen per person so it follows them to any till.
 * "standard" is the shop's own look and always the default. A variation is listed here once its screens are built; the picker in
 * Settings and on the till appears only when there is more than one to choose from.
 */
export type LookId = "standard" | "orange-waffle";
export interface Look { id: LookId; name: string; note: string; /** Built and ready to choose. */ ready: boolean }
export const LOOKS: Look[] = [
  { id: "standard", name: "Standard", note: "The shop's own look.", ready: true },
  { id: "orange-waffle", name: "Orange Waffle", note: "A variation for staff used to that layout.", ready: false },
];
export const READY_LOOKS = LOOKS.filter((l) => l.ready);
/** The look to draw: the person's choice when it is built, the standard one otherwise. */
export const lookOf = (id: string | undefined): LookId => READY_LOOKS.find((l) => l.id === id)?.id ?? "standard";
