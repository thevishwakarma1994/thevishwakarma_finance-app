export type Paise = number & { readonly __brand: "Paise" };

/** Inclusive bounds: every domain Paise value must be a JS safe integer. */
export const MIN_SAFE_PAISE = Number.MIN_SAFE_INTEGER;
export const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

export function paise(value: number): Paise {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Paise must be a safe integer");
  }
  return value as Paise;
}

export function addPaise(a: Paise, b: Paise): Paise {
  return paise(a + b);
}

export function sumPaise(values: readonly Paise[]): Paise {
  return values.reduce<Paise>((acc, value) => addPaise(acc, value), paise(0));
}

export function absPaise(value: Paise): Paise {
  return paise(Math.abs(value));
}
