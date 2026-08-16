import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import {
  generateObligationInstances,
  parseDueRule,
  dueOnForMonth,
  CONFIG_OBLIGATION_AMOUNT,
  CONFIG_OBLIGATION_PRIORITY,
  type ObligationConfigRow,
} from "../../src/domain/obligations/generate.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { comingUpItems } from "../../src/domain/engine/comingUp.js";
import type { ObligationTemplate } from "../../src/domain/ledger/types.js";
import {
  accountFixture,
  fundingCycleFixture,
  obligationInstanceFixture,
  paiseOf,
  snapshotFixture,
} from "./fixtures.js";

function rentTemplate(overrides: Partial<ObligationTemplate> = {}): ObligationTemplate {
  return {
    id: "rent",
    name: "Rent",
    priority: "must_pay",
    dueRule: { dayOfMonth: 5 },
    defaultAccountId: null,
    loanId: null,
    effectiveFrom: isoDate("2025-01-01"),
    effectiveTo: null,
    ...overrides,
  };
}

function amountConfig(from: string, amount: number, to: string | null = null): ObligationConfigRow {
  return {
    key: CONFIG_OBLIGATION_AMOUNT,
    subjectId: "rent",
    effectiveFrom: isoDate(from),
    effectiveTo: to ? isoDate(to) : null,
    value: { amountPaise: paiseOf(amount) },
  };
}

describe("obligation generation", () => {
  it("A — monthly rent due on the 5th", () => {
    const created = generateObligationInstances({
      templates: [rentTemplate()],
      existing: [],
      configs: [amountConfig("2025-01-01", 12_000)],
      asOf: isoDate("2026-08-16"),
      monthsBack: 0,
      monthsForward: 0,
    });
    const august = created.find((item) => item.dueOn === isoDate("2026-08-05"));
    expect(august?.amountPaise).toBe(paiseOf(12_000));
    expect(august?.prioritySnapshot).toBe("must_pay");
    expect(august?.nameSnapshot).toBe("Rent");
  });

  it("B — generating twice does not duplicate", () => {
    const first = generateObligationInstances({
      templates: [rentTemplate()],
      existing: [],
      configs: [amountConfig("2025-01-01", 12_000)],
      asOf: isoDate("2026-08-16"),
      monthsBack: 0,
      monthsForward: 0,
    });
    const second = generateObligationInstances({
      templates: [rentTemplate()],
      existing: first,
      configs: [amountConfig("2025-01-01", 12_000)],
      asOf: isoDate("2026-08-16"),
      monthsBack: 0,
      monthsForward: 0,
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("C — amount change snapshots per due date", () => {
    const configs = [amountConfig("2025-01-01", 12_000, "2026-01-01"), amountConfig("2026-01-01", 13_000)];
    const created = generateObligationInstances({
      templates: [rentTemplate()],
      existing: [],
      configs,
      asOf: isoDate("2026-01-10"),
      monthsBack: 1,
      monthsForward: 0,
    });
    expect(created.find((item) => item.dueOn === isoDate("2025-12-05"))?.amountPaise).toBe(paiseOf(12_000));
    expect(created.find((item) => item.dueOn === isoDate("2026-01-05"))?.amountPaise).toBe(paiseOf(13_000));
  });

  it("D — later priority change does not rewrite an existing snapshot", () => {
    const first = generateObligationInstances({
      templates: [rentTemplate({ priority: "must_pay" })],
      existing: [],
      configs: [
        amountConfig("2025-01-01", 12_000),
        {
          key: CONFIG_OBLIGATION_PRIORITY,
          subjectId: "rent",
          effectiveFrom: isoDate("2025-01-01"),
          effectiveTo: isoDate("2026-09-01"),
          value: { priority: "must_pay" },
        },
      ],
      asOf: isoDate("2026-08-16"),
      monthsBack: 0,
      monthsForward: 0,
    });
    const later = generateObligationInstances({
      templates: [rentTemplate({ priority: "committed" })],
      existing: first,
      configs: [
        amountConfig("2025-01-01", 12_000),
        {
          key: CONFIG_OBLIGATION_PRIORITY,
          subjectId: "rent",
          effectiveFrom: isoDate("2026-09-01"),
          effectiveTo: null,
          value: { priority: "committed" },
        },
      ],
      asOf: isoDate("2026-09-16"),
      monthsBack: 1,
      monthsForward: 0,
    });
    expect(first[0]?.prioritySnapshot).toBe("must_pay");
    expect(later.find((item) => item.dueOn === isoDate("2026-08-05"))).toBeUndefined();
    expect(later.find((item) => item.dueOn === isoDate("2026-09-05"))?.prioritySnapshot).toBe("committed");
  });

  it("E — February clamps day 31 to month end", () => {
    expect(dueOnForMonth(parseDueRule({ dayOfMonth: 31 }), 2026, 2)).toBe(isoDate("2026-02-28"));
  });

  it("F — leap February clamps day 31 to the 29th", () => {
    expect(dueOnForMonth(parseDueRule({ dayOfMonth: 31 }), 2028, 2)).toBe(isoDate("2028-02-29"));
  });
});

describe("obligation STS inclusion", () => {
  const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
  const augArrived = fundingCycleFixture({
    year: 2026,
    month: 8,
    actualArrivalOn: isoDate("2026-08-05"),
    actualAmountPaise: paiseOf(79_200),
    salaryEventId: "salary-aug",
  });

  it("H — must-pay instance is included by Stage 12 rules", () => {
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      fundingCycles: [augArrived],
      obligationInstances: [
        obligationInstanceFixture({
          name: "Rent",
          dueOn: isoDate("2026-08-18"),
          amountPaise: paiseOf(5_000),
          prioritySnapshot: "must_pay",
        }),
      ],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.includedObligations.some((item) => item.priority === "must_pay")).toBe(true);
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(15_000));
  });

  it("I — committed instance uses the same inclusion rules", () => {
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      fundingCycles: [augArrived],
      obligationInstances: [
        obligationInstanceFixture({
          name: "Insurance",
          dueOn: isoDate("2026-08-18"),
          amountPaise: paiseOf(2_000),
          prioritySnapshot: "committed",
        }),
      ],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.includedObligations.some((item) => item.priority === "committed")).toBe(true);
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(18_000));
  });

  it("J — planned is visible in Coming Up and does not reduce STS", () => {
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      fundingCycles: [augArrived],
      obligationInstances: [
        obligationInstanceFixture({
          name: "SIP",
          dueOn: isoDate("2026-08-18"),
          amountPaise: paiseOf(5_000),
          prioritySnapshot: "planned",
        }),
      ],
    });
    const asOf = isoDate("2026-08-20");
    const sts = evaluateSafeToSpend(snapshot, asOf);
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(20_000));
    expect(sts.plannedNotSubtracted.some((item) => item.name.includes("SIP"))).toBe(true);
    expect(comingUpItems(snapshot, asOf).some((item) => item.name === "SIP")).toBe(true);
  });

  it("K — delayed salary includes a real instance due 24 Sep", () => {
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      fundingCycles: [augArrived],
      obligationInstances: [
        obligationInstanceFixture({
          name: "Family",
          dueOn: isoDate("2026-09-24"),
          amountPaise: paiseOf(8_000),
          prioritySnapshot: "must_pay",
        }),
      ],
    });
    const third = evaluateSafeToSpend(snapshot, isoDate("2026-09-03"));
    const sixth = evaluateSafeToSpend(snapshot, isoDate("2026-09-06"));
    const tenth = evaluateSafeToSpend(snapshot, isoDate("2026-09-10"));
    expect(third.currentCycleSafeToSpend).toBe(paiseOf(20_000));
    expect(sixth.currentCycleSafeToSpend).toBe(paiseOf(20_000));
    expect(tenth.includedObligations[0]?.unfunded).toBe(paiseOf(8_000));
    expect(tenth.currentCycleSafeToSpend).toBe(paiseOf(12_000));
    expect(tenth.riskFlags).toContain("expected_income_delayed");
  });
});
