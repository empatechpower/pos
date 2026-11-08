/** All money in the system is an integer number of cents (SGD). Never floats. */
export type Cents = number;

export const formatMoney = (cents: Cents): string =>
  `${cents < 0 ? "-" : ""}S$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Percentage of an amount, rounded half-up to the nearest cent. */
export const percentOf = (cents: Cents, rate: number): Cents => Math.round(cents * rate);
