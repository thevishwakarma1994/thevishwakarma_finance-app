export type Paise = number & { readonly __brand: "Paise" };

export function paise(value: number): Paise {
  if (!Number.isInteger(value)) {
    throw new Error("Paise must be an integer");
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
