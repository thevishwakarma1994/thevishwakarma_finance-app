import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { assignBillingCycle } from "../../src/domain/cycle/assign.js";

const day12 = { statementDay: 12, dueDaysAfterStatement: 18 };
const day31 = { statementDay: 31, dueDaysAfterStatement: 18 };

describe("billing cycle assignment (Kolkata civil dates)", () => {
  it("puts a spend one day before cutoff in this month's cycle", () => {
    const assigned = assignBillingCycle(isoDate("2026-08-11"), day12);
    expect(assigned.expectedStatementOn).toBe("2026-08-12");
    expect(assigned.purchaseWindowStart).toBe("2026-07-13");
    expect(assigned.purchaseWindowEnd).toBe("2026-08-12");
    expect(assigned.expectedDueOn).toBe("2026-08-30");
  });

  it("puts a spend on cutoff day in that cycle", () => {
    const assigned = assignBillingCycle(isoDate("2026-08-12"), day12);
    expect(assigned.expectedStatementOn).toBe("2026-08-12");
    expect(assigned.purchaseWindowEnd).toBe("2026-08-12");
  });

  it("puts a spend one day after cutoff in the next cycle", () => {
    const assigned = assignBillingCycle(isoDate("2026-08-13"), day12);
    expect(assigned.expectedStatementOn).toBe("2026-09-12");
    expect(assigned.purchaseWindowStart).toBe("2026-08-13");
    expect(assigned.purchaseWindowEnd).toBe("2026-09-12");
    expect(assigned.expectedDueOn).toBe("2026-09-30");
  });

  it("matches the Stage 4 example: 18 Aug → statement 12 Sep, due 30 Sep", () => {
    const assigned = assignBillingCycle(isoDate("2026-08-18"), day12);
    expect(assigned.expectedStatementOn).toBe("2026-09-12");
    expect(assigned.expectedDueOn).toBe("2026-09-30");
  });

  it("handles month-end transition for statement day 31", () => {
    const january = assignBillingCycle(isoDate("2026-01-31"), day31);
    expect(january.expectedStatementOn).toBe("2026-01-31");
    const february = assignBillingCycle(isoDate("2026-02-01"), day31);
    expect(february.expectedStatementOn).toBe("2026-02-28");
    expect(february.purchaseWindowStart).toBe("2026-02-01");
  });

  it("clamps February non-leap statement day 31 to the 28th", () => {
    const assigned = assignBillingCycle(isoDate("2026-02-28"), day31);
    expect(assigned.expectedStatementOn).toBe("2026-02-28");
    const next = assignBillingCycle(isoDate("2026-03-01"), day31);
    expect(next.expectedStatementOn).toBe("2026-03-31");
    expect(next.purchaseWindowStart).toBe("2026-03-01");
  });

  it("clamps leap-year February statement day 31 to the 29th", () => {
    const assigned = assignBillingCycle(isoDate("2024-02-29"), day31);
    expect(assigned.expectedStatementOn).toBe("2024-02-29");
    const next = assignBillingCycle(isoDate("2024-03-01"), day31);
    expect(next.expectedStatementOn).toBe("2024-03-31");
    expect(next.purchaseWindowStart).toBe("2024-03-01");
  });

  it("handles year-end transition", () => {
    const onCutoff = assignBillingCycle(isoDate("2025-12-12"), day12);
    expect(onCutoff.expectedStatementOn).toBe("2025-12-12");
    const afterCutoff = assignBillingCycle(isoDate("2025-12-13"), day12);
    expect(afterCutoff.expectedStatementOn).toBe("2026-01-12");
    expect(afterCutoff.purchaseWindowStart).toBe("2025-12-13");
    expect(afterCutoff.expectedDueOn).toBe("2026-01-30");
  });
});
