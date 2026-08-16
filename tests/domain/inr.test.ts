import { describe, expect, it } from "vitest";
import {
  formatInr,
  formatInrDelta,
  parseInr,
  paiseToRupees,
  rupeesToPaise,
} from "../../src/domain/money/inr.js";
import { paise } from "../../src/domain/money/paise.js";

describe("INR conversion", () => {
  it("converts rupees to integer paise", () => {
    expect(rupeesToPaise(79_200)).toBe(7_920_000);
    expect(rupeesToPaise(1_250.5)).toBe(125_050);
    expect(paiseToRupees(paise(7_920_000))).toBe(79_200);
  });

  it("parses grouped and decimal INR strings", () => {
    expect(parseInr("79200")).toBe(7_920_000);
    expect(parseInr("79,200")).toBe(7_920_000);
    expect(parseInr("₹1,250.50")).toBe(125_050);
    expect(parseInr("1250")).toBe(125_000);
  });

  it("formats INR and signed deltas", () => {
    expect(formatInr(paise(7_920_000))).toBe("₹79,200");
    expect(formatInrDelta(paise(7_920_000))).toBe("+₹79,200");
    expect(formatInrDelta(paise(-125_000))).toBe("−₹1,250");
  });

  it("rejects invalid input", () => {
    expect(() => parseInr("")).toThrow(/required/);
    expect(() => parseInr("12.345")).toThrow(/valid INR/);
    expect(() => parseInr("abc")).toThrow(/valid INR/);
  });
});
