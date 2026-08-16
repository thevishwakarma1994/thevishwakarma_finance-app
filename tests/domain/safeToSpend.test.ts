import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { evaluateSafeToSpend, inThisNumberTotal } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { deriveFundingCycleStatus, materializeFundingCycles, shiftYearMonth } from "../../src/domain/funding/cycles.js";
import {
  accountFixture,
  cardFixture,
  claimFixture,
  cycleFixture,
  fundingCycleFixture,
  incomePolicyFixture,
  paiseOf,
  personFixture,
  reservationFixture,
  snapshotFixture,
} from "./fixtures.js";

const augArrived = fundingCycleFixture({
  year: 2026,
  month: 8,
  actualArrivalOn: isoDate("2026-08-05"),
  actualAmountPaise: paiseOf(79_200),
  salaryEventId: "salary-aug",
});

describe("safe to spend", () => {
  it("A — reserved is excluded from available and STS", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(10_000) });
    const cycle = cycleFixture({
      id: "axis",
      remainingPaise: paiseOf(10_000),
      expectedDueOn: isoDate("2026-09-24"),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      billingCycles: [cycle],
      reservations: [
        reservationFixture({
          sourceAccountId: hdfc.id,
          obligationRef: { type: "billing_cycle", id: cycle.id },
          amountOriginalPaise: paiseOf(4_000),
        }),
      ],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.availableLiquid).toBe(paiseOf(6_000));
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(6_000));
  });

  it("B — pending surplus is excluded once, not twice", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(10_000) });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      surplusCases: [
        {
          id: "surplus-1",
          amountPaise: paiseOf(3_000),
          kind: "unallocated_settlement",
          sourceAccountId: hdfc.id,
          personId: null,
          reservationId: null,
          eventId: null,
          explanation: "Unallocated",
          status: "pending",
          resolution: null,
          resolvedAt: null,
          resolvedByEventId: null,
        },
      ],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.availableLiquid).toBe(paiseOf(7_000));
    expect(sts.reservedTotal).toBe(paiseOf(3_000));
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(7_000));
  });

  it("C — receivables do not increase STS", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const rahul = personFixture({ id: "rahul" });
    const without = evaluateSafeToSpend(
      snapshotFixture({ accounts: [hdfc], fundingCycles: [augArrived] }),
      isoDate("2026-08-20"),
    );
    const withClaim = evaluateSafeToSpend(
      snapshotFixture({
        accounts: [hdfc],
        people: [rahul],
        claims: [claimFixture({ personId: rahul.id, openAmountPaise: paiseOf(5_000) })],
        fundingCycles: [augArrived],
      }),
      isoDate("2026-08-20"),
    );
    expect(withClaim.currentCycleSafeToSpend).toBe(without.currentCycleSafeToSpend);
    expect(withClaim.unreceivedClaimsTotal).toBe(paiseOf(5_000));
  });

  it("D — card STS subtracts only unfunded, not remaining and reserved", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(50_000) });
    const card = cardFixture({ id: "icici" });
    const cycle = cycleFixture({
      id: "icici-cycle",
      creditCardId: card.id,
      remainingPaise: paiseOf(10_000),
      expectedDueOn: isoDate("2026-08-18"),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      creditCards: [card],
      billingCycles: [cycle],
      reservations: [
        reservationFixture({
          sourceAccountId: hdfc.id,
          obligationRef: { type: "billing_cycle", id: cycle.id },
          amountOriginalPaise: paiseOf(6_000),
        }),
      ],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.includedObligations[0]?.unfunded).toBe(paiseOf(4_000));
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(40_000));
  });

  it("E — normal next salary window excludes post-window card", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const card = cardFixture({ id: "icici" });
    const cycle = cycleFixture({
      id: "icici-cycle",
      creditCardId: card.id,
      remainingPaise: paiseOf(8_000),
      expectedDueOn: isoDate("2026-09-24"),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      creditCards: [card],
      billingCycles: [cycle],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.includedObligations).toHaveLength(0);
    expect(sts.excludedFutureObligations).toHaveLength(1);
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(20_000));
  });

  it("F — during salary window, unreceived dues after the window stay out", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const card = cardFixture({ id: "icici" });
    const cycle = cycleFixture({
      id: "icici-cycle",
      creditCardId: card.id,
      remainingPaise: paiseOf(8_000),
      expectedDueOn: isoDate("2026-09-24"),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      creditCards: [card],
      billingCycles: [cycle],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-09-06"));
    expect(sts.fundingCycles.find((item) => item.year === 2026 && item.month === 9)?.status).toBe(
      "window_open_unreceived",
    );
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(20_000));
    expect(sts.riskFlags).not.toContain("expected_income_delayed");
  });

  it("G — after salary window failure sets salary_delayed and risk flag", () => {
    const snapshot = snapshotFixture({
      accounts: [accountFixture({ balancePaise: paiseOf(20_000) })],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-09-10"));
    expect(sts.fundingCycles.find((item) => item.year === 2026 && item.month === 9)?.status).toBe(
      "salary_delayed",
    );
    expect(sts.riskFlags).toContain("expected_income_delayed");
  });

  it("H / Scenario O — delayed cover-through includes the 24 Sep card", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const card = cardFixture({ id: "icici" });
    const cycle = cycleFixture({
      id: "icici-cycle",
      creditCardId: card.id,
      remainingPaise: paiseOf(8_000),
      expectedDueOn: isoDate("2026-09-24"),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      creditCards: [card],
      billingCycles: [cycle],
      fundingCycles: [augArrived],
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

  it("I — actual salary arrival clears delayed handling", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(99_200) });
    const card = cardFixture({ id: "icici" });
    const cycle = cycleFixture({
      id: "icici-cycle",
      creditCardId: card.id,
      remainingPaise: paiseOf(8_000),
      expectedDueOn: isoDate("2026-09-24"),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      creditCards: [card],
      billingCycles: [cycle],
      fundingCycles: [
        { ...augArrived, actualArrivalOn: isoDate("2026-08-05") },
        fundingCycleFixture({
          year: 2026,
          month: 9,
          actualArrivalOn: isoDate("2026-09-12"),
          actualAmountPaise: paiseOf(79_200),
          salaryEventId: "salary-sep",
        }),
      ],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-09-12"));
    expect(sts.fundingCycles.find((item) => item.month === 9)?.status).toBe("active");
    expect(sts.riskFlags).not.toContain("expected_income_delayed");
    expect(sts.includedObligations[0]?.unfunded).toBe(paiseOf(8_000));
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(91_200));
  });

  it("J — negative STS is preserved, not clamped", () => {
    const snapshot = snapshotFixture({
      accounts: [accountFixture({ balancePaise: paiseOf(1_000) })],
      extraObligations: [
        {
          id: "rent",
          name: "Rent",
          dueOn: isoDate("2026-08-18"),
          remainingPaise: paiseOf(5_000),
          reservedPaise: paise(0),
          priority: "must_pay",
        },
      ],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(-4_000));
    expect(sts.riskFlags).toContain("insufficient_for_must_pays");
  });

  it("K — budget does not reduce STS", () => {
    const snapshot = snapshotFixture({
      accounts: [accountFixture({ balancePaise: paiseOf(20_000) })],
      fundingCycles: [augArrived],
      budgets: [{ categoryId: "cat-grocery", calendarYear: 2026, calendarMonth: 8, amountPaise: paiseOf(8_000) }],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(20_000));
    expect(sts.budgetsIgnored).toHaveLength(1);
  });

  it("L — statement mismatch uses conservative STS obligation, not payment cap", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const card = cardFixture({ id: "icici" });
    const asOf = isoDate("2026-08-20");

    const caseA = evaluateSafeToSpend(
      snapshotFixture({
        accounts: [hdfc],
        creditCards: [card],
        billingCycles: [
          cycleFixture({
            id: "a",
            creditCardId: card.id,
            expectedDueOn: isoDate("2026-08-18"),
            ledgerRemainingPaise: paiseOf(10_000),
            statementRemainingPaise: paiseOf(10_500),
            remainingPaise: paiseOf(10_000),
            mismatch: true,
            actualStatementAmountPaise: paiseOf(10_500),
          }),
        ],
        fundingCycles: [augArrived],
      }),
      asOf,
    );
    expect(caseA.includedObligations[0]?.unfunded).toBe(paiseOf(10_500));
    expect(caseA.currentCycleSafeToSpend).toBe(paiseOf(9_500));
    expect(caseA.riskFlags).toContain("statement_mismatch");

    const caseB = evaluateSafeToSpend(
      snapshotFixture({
        accounts: [hdfc],
        creditCards: [card],
        billingCycles: [
          cycleFixture({
            id: "b",
            creditCardId: card.id,
            expectedDueOn: isoDate("2026-08-18"),
            ledgerRemainingPaise: paiseOf(10_000),
            statementRemainingPaise: paiseOf(9_500),
            remainingPaise: paiseOf(9_500),
            mismatch: true,
            actualStatementAmountPaise: paiseOf(9_500),
          }),
        ],
        fundingCycles: [augArrived],
      }),
      asOf,
    );
    expect(caseB.includedObligations[0]?.unfunded).toBe(paiseOf(10_000));
    expect(caseB.currentCycleSafeToSpend).toBe(paiseOf(10_000));
    expect(caseB.riskFlags).toContain("statement_mismatch");

    const caseC = evaluateSafeToSpend(
      snapshotFixture({
        accounts: [hdfc],
        creditCards: [card],
        billingCycles: [
          cycleFixture({
            id: "c",
            creditCardId: card.id,
            expectedDueOn: isoDate("2026-08-18"),
            ledgerRemainingPaise: paiseOf(10_000),
            statementRemainingPaise: paiseOf(10_000),
            remainingPaise: paiseOf(10_000),
          }),
        ],
        fundingCycles: [augArrived],
      }),
      asOf,
    );
    expect(caseC.includedObligations[0]?.unfunded).toBe(paiseOf(10_000));
    expect(caseC.currentCycleSafeToSpend).toBe(paiseOf(10_000));
    expect(caseC.riskFlags).not.toContain("statement_mismatch");

    const caseD = evaluateSafeToSpend(
      snapshotFixture({
        accounts: [hdfc],
        creditCards: [card],
        billingCycles: [
          cycleFixture({
            id: "d",
            creditCardId: card.id,
            expectedDueOn: isoDate("2026-08-18"),
            ledgerRemainingPaise: paiseOf(10_000),
            statementRemainingPaise: paiseOf(10_500),
            remainingPaise: paiseOf(10_000),
            mismatch: true,
            actualStatementAmountPaise: paiseOf(10_500),
          }),
        ],
        reservations: [
          reservationFixture({
            sourceAccountId: hdfc.id,
            obligationRef: { type: "billing_cycle", id: "d" },
            amountOriginalPaise: paiseOf(6_000),
          }),
        ],
        fundingCycles: [augArrived],
      }),
      asOf,
    );
    expect(caseD.includedObligations[0]?.unfunded).toBe(paiseOf(4_500));
    expect(caseD.availableLiquid).toBe(paiseOf(14_000));
    expect(caseD.currentCycleSafeToSpend).toBe(paiseOf(9_500));
    expect(caseD.riskFlags).toContain("statement_mismatch");
  });

  it("M — explanation items reconcile exactly with headline STS", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      extraObligations: [
        {
          id: "rent",
          name: "Rent",
          dueOn: isoDate("2026-08-18"),
          remainingPaise: paiseOf(6_500),
          reservedPaise: paise(0),
          priority: "must_pay",
        },
      ],
      fundingCycles: [augArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(inThisNumberTotal(sts.explanationItems)).toBe(sts.currentCycleSafeToSpend);
  });

  it("does not seed fictional salary windows when income policy is absent", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const card = cardFixture({ id: "icici" });
    const cycle = cycleFixture({
      id: "icici-cycle",
      creditCardId: card.id,
      remainingPaise: paiseOf(8_000),
      expectedDueOn: isoDate("2026-09-24"),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      creditCards: [card],
      billingCycles: [cycle],
      incomePolicies: [],
      fundingCycles: [],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-09-10"));
    expect(sts.incomePolicyConfigured).toBe(false);
    expect(sts.fundingCycles).toHaveLength(0);
    expect(sts.nextExpectedIncomeWindow.start).toBeNull();
    expect(sts.nextExpectedIncomeWindow.expectedAmount).toBe(0);
    expect(sts.riskFlags).toContain("salary_schedule_not_configured");
    expect(sts.riskFlags).not.toContain("expected_income_delayed");
    expect(sts.explanationItems.some((item) => item.label === "Salary schedule not configured")).toBe(
      true,
    );
    expect(sts.includedObligations).toHaveLength(0);
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(20_000));
  });

  it("still evaluates real liquid money when salary schedule is not configured", () => {
    const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      incomePolicies: [],
      fundingCycles: [],
      extraObligations: [
        {
          id: "rent",
          name: "Rent",
          dueOn: isoDate("2026-08-18"),
          remainingPaise: paiseOf(5_000),
          reservedPaise: paise(0),
          priority: "must_pay",
        },
      ],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.availableLiquid).toBe(paiseOf(20_000));
    expect(sts.currentCycleSafeToSpend).toBe(paiseOf(15_000));
    expect(sts.incomePolicyConfigured).toBe(false);
  });

  it("ignores a future salary arrival when evaluating a historical asOf", () => {
    const octArrived = fundingCycleFixture({
      year: 2026,
      month: 10,
      actualArrivalOn: isoDate("2026-10-05"),
      actualAmountPaise: paiseOf(79_200),
      salaryEventId: "salary-oct",
    });
    const snapshot = snapshotFixture({
      accounts: [accountFixture({ balancePaise: paiseOf(20_000) })],
      fundingCycles: [augArrived, octArrived],
    });
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-09-10"));
    const october = sts.fundingCycles.find((cycle) => cycle.year === 2026 && cycle.month === 10);
    expect(october?.status).toBe("upcoming");
    expect(sts.activeFundingCycleId).toBe(augArrived.id);
    expect(sts.fundingCycles.find((cycle) => cycle.month === 9)?.status).toBe("salary_delayed");
    expect(sts.delayedFundingCycleIds.length).toBeGreaterThan(0);
    expect(sts.riskFlags).toContain("expected_income_delayed");
    expect(sts.riskFlags).not.toContain("salary_schedule_not_configured");
  });
});

describe("funding cycle dates", () => {
  it("treats the day after the window as salary_delayed", () => {
    const cycle = fundingCycleFixture({ year: 2026, month: 9 });
    expect(deriveFundingCycleStatus(cycle, isoDate("2026-09-08"), [cycle])).toBe("window_open_unreceived");
    expect(deriveFundingCycleStatus(cycle, isoDate("2026-09-09"), [cycle])).toBe("salary_delayed");
  });

  it("walks December to January without UTC midnight", () => {
    const next = shiftYearMonth(2026, 12, 1);
    expect(next).toEqual({ year: 2027, month: 1 });
    const materialized = materializeFundingCycles(
      [incomePolicyFixture()],
      [],
      isoDate("2026-12-20"),
      0,
      1,
    );
    expect(materialized.some((cycle) => cycle.year === 2027 && cycle.month === 1)).toBe(true);
  });

  it("does not materialize funding cycles when no income policy exists", () => {
    expect(materializeFundingCycles([], [], isoDate("2026-09-10"))).toEqual([]);
  });
});
