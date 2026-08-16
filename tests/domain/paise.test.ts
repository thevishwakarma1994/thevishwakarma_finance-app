import { describe, expect, it } from "vitest";
import { absPaise, addPaise, paise, sumPaise } from "../../src/domain/money/paise.js";

describe("Paise", () => {
  it("accepts integers only", () => {
    expect(paise(0)).toBe(0);
    expect(paise(7920000)).toBe(7_920_000);
    expect(() => paise(1.5)).toThrow(/integer/);
  });

  it("adds and sums without converting to rupees", () => {
    expect(addPaise(paise(180_000), paise(120_000))).toBe(300_000);
    expect(sumPaise([paise(-300_000), paise(180_000), paise(120_000)])).toBe(0);
  });

  it("takes absolute value", () => {
    expect(absPaise(paise(-125_000))).toBe(125_000);
  });
});
