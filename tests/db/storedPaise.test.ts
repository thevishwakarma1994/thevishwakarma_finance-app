import { describe, expect, it } from "vitest";
import { MAX_SAFE_PAISE, paise } from "../../src/domain/money/paise.js";
import { fromStoredPaise, fromStoredPaiseOrNull } from "../../src/db/storedPaise.js";

describe("stored Paise boundary", () => {
  it("A. rounds ₹79,200 exactly from number, string, and bigint", () => {
    expect(fromStoredPaise(7_920_000)).toBe(7_920_000);
    expect(fromStoredPaise("7920000")).toBe(7_920_000);
    expect(fromStoredPaise(7_920_000n)).toBe(7_920_000);
  });

  it("B. rounds ₹0.01 exactly", () => {
    expect(fromStoredPaise(1)).toBe(1);
    expect(fromStoredPaise("1")).toBe(1);
    expect(fromStoredPaise(1n)).toBe(1);
  });

  it("C. accepts the largest safe Paise value", () => {
    expect(fromStoredPaise(MAX_SAFE_PAISE)).toBe(MAX_SAFE_PAISE);
    expect(fromStoredPaise(String(MAX_SAFE_PAISE))).toBe(MAX_SAFE_PAISE);
    expect(fromStoredPaise(BigInt(MAX_SAFE_PAISE))).toBe(MAX_SAFE_PAISE);
  });

  it("D. rejects values above the safe range", () => {
    const unsafe = BigInt(MAX_SAFE_PAISE) + 2n;
    expect(() => fromStoredPaise(unsafe)).toThrow(/safe integer|exceeds/);
    expect(() => fromStoredPaise(unsafe.toString())).toThrow(/safe integer|exceeds/);
    expect(() => paise(MAX_SAFE_PAISE + 1)).toThrow(/safe integer/);
  });

  it("E. keeps permitted negatives exact", () => {
    expect(fromStoredPaise(-125_000)).toBe(-125_000);
    expect(fromStoredPaise("-125000")).toBe(-125_000);
    expect(fromStoredPaise(-125_000n)).toBe(-125_000);
  });

  it("F. does not accept a silently rounded unsafe BIGINT", () => {
    const unsafe = 9007199254740993n;
    expect(Number(unsafe)).toBe(9007199254740992);
    expect(() => fromStoredPaise(unsafe)).toThrow(/safe integer|exceeds/);
    expect(() => fromStoredPaise("9007199254740993")).toThrow(/safe integer|exceeds/);
  });

  it("maps null stored values to null", () => {
    expect(fromStoredPaiseOrNull(null)).toBeNull();
    expect(fromStoredPaiseOrNull(undefined)).toBeNull();
    expect(fromStoredPaiseOrNull(1)).toBe(1);
  });
});
