import { paise, type Paise } from "./paise.js";

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new Error("Invalid rupee amount");
  }
  return paise(Math.round(rupees * 100));
}

export function paiseToRupees(value: Paise): number {
  return value / 100;
}

/** Parse user input such as "79200", "79,200", "1250.50". */
export function parseInr(input: string): Paise {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Amount is required");
  }
  const normalized = trimmed.replace(/₹/g, "").replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Enter a valid INR amount");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const sign = whole.startsWith("-") ? -1 : 1;
  const absWhole = whole.replace("-", "");
  const fractionPaise = (fraction + "00").slice(0, 2);
  return paise(sign * (Number(absWhole) * 100 + Number(fractionPaise)));
}

export function formatInr(value: Paise): string {
  return INR.format(paiseToRupees(value));
}

export function formatInrDelta(value: Paise): string {
  const formatted = formatInr(absPaiseForFormat(value));
  if (value > 0) return `+${formatted}`;
  if (value < 0) return `−${formatted}`;
  return formatted;
}

function absPaiseForFormat(value: Paise): Paise {
  return paise(Math.abs(value));
}
