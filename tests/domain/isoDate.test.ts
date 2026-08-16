import { describe, expect, it } from "vitest";
import { inCalendarMonth, isoDate, isoDateParts, isoMonth } from "../../src/domain/calendar/isoDate.js";

describe("IsoDate", () => {
  it("accepts calendar dates", () => {
    const value = isoDate("2026-08-16");
    expect(isoDateParts(value)).toEqual({ year: 2026, month: 8, day: 16 });
    expect(isoMonth(value)).toEqual({ year: 2026, month: 8 });
    expect(inCalendarMonth(value, 2026, 8)).toBe(true);
    expect(inCalendarMonth(value, 2026, 7)).toBe(false);
  });

  it("rejects non-dates and impossible days", () => {
    expect(() => isoDate("16-08-2026")).toThrow(/Invalid IsoDate/);
    expect(() => isoDate("2026-02-30")).toThrow(/Invalid calendar date/);
    expect(() => isoDate("2026-13-01")).toThrow(/Invalid calendar date/);
  });

  it("accepts leap-day 2024-02-29", () => {
    expect(isoDate("2024-02-29")).toBe("2024-02-29");
  });
});
