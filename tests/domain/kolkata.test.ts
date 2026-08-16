import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import {
  kolkataAddMonths,
  kolkataMonthEnd,
  kolkataMonthStart,
  todayKolkata,
} from "../../src/domain/calendar/kolkata.js";

describe("Kolkata date and month boundaries", () => {
  it("uses Asia/Kolkata civil date, not UTC", () => {
    const justBefore = DateTime.fromISO("2026-03-31T18:29:00.000Z", { zone: "utc" });
    const justAfter = DateTime.fromISO("2026-03-31T18:30:00.000Z", { zone: "utc" });
    expect(todayKolkata(justBefore)).toBe("2026-03-31");
    expect(todayKolkata(justAfter)).toBe("2026-04-01");
  });

  it("returns inclusive month start and end", () => {
    expect(kolkataMonthStart(isoDate("2026-08-16"))).toBe("2026-08-01");
    expect(kolkataMonthEnd(isoDate("2026-08-16"))).toBe("2026-08-31");
    expect(kolkataMonthEnd(isoDate("2026-02-10"))).toBe("2026-02-28");
    expect(kolkataMonthEnd(isoDate("2024-02-10"))).toBe("2024-02-29");
    expect(kolkataMonthStart(kolkataAddMonths(isoDate("2026-08-01"), -1))).toBe("2026-07-01");
    expect(kolkataMonthEnd(kolkataAddMonths(isoDate("2026-03-31"), -1))).toBe("2026-02-28");
  });
});
