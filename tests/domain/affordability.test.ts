import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { simulateAffordability } from "../../src/domain/engine/simulateAffordability.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import {
  accountFixture,
  cardFixture,
  fundingCycleFixture,
  paiseOf,
  snapshotFixture,
} from "./fixtures.js";

const capturedSnapshot = () => {
  const hdfc = accountFixture({ id: "hdfc", balancePaise: paiseOf(50_000) });
  return snapshotFixture({
    accounts: [hdfc],
    fundingCycles: [
      fundingCycleFixture({
        year: 2026,
        month: 8,
        actualArrivalOn: isoDate("2026-08-05"),
        actualAmountPaise: paiseOf(79_200),
        salaryEventId: "salary-aug",
      }),
    ],
    cardRules: [{ creditCardId: "card-1", rule: { statementDay: 25, dueDaysAfterStatement: 18 } }],
    creditCards: [cardFixture({ id: "card-1", displayName: "HDFC" })],
  });
};

describe("affordability simulation", () => {
  it("N — account-funded proposal is applied in-memory only", () => {
    const snapshot = capturedSnapshot();
    const beforeEvents = snapshot.events.length;
    const result = simulateAffordability(snapshot, isoDate("2026-08-25"), {
      amountPaise: paiseOf(5_000),
      occurredOn: isoDate("2026-08-25"),
      funding: { accountId: "hdfc" },
      meaning: "spend_account",
    });
    expect(snapshot.events).toHaveLength(beforeEvents);
    expect(result.afterCurrent.currentCycleSafeToSpend).toBe(paiseOf(45_000));
    expect(result.baseline.currentCycleSafeToSpend).toBe(paiseOf(50_000));
  });

  it("O — card affordability assigns the due cycle", () => {
    const snapshot = capturedSnapshot();
    const result = simulateAffordability(snapshot, isoDate("2026-08-28"), {
      amountPaise: paiseOf(20_000),
      occurredOn: isoDate("2026-08-28"),
      funding: { creditCardId: "card-1" },
      meaning: "spend_card",
    });
    expect(result.afterCurrent.currentCycleSafeToSpend).toBe(result.baseline.currentCycleSafeToSpend);
    const oct = result.cycleProjections.find((item) => item.month === 10);
    expect(oct).toBeTruthy();
  });

  it("P — dynamic horizon walks more than one future cycle when the bill lands later", () => {
    const snapshot = snapshotFixture({
      accounts: [accountFixture({ id: "hdfc", balancePaise: paiseOf(50_000) })],
      fundingCycles: [
        fundingCycleFixture({
          year: 2026,
          month: 8,
          actualArrivalOn: isoDate("2026-08-05"),
          actualAmountPaise: paiseOf(79_200),
          salaryEventId: "salary-aug",
        }),
      ],
      extraObligations: [
        {
          id: "sep-bills",
          name: "September must-pays",
          dueOn: isoDate("2026-09-20"),
          remainingPaise: paiseOf(70_000),
          reservedPaise: paise(0),
          priority: "must_pay",
        },
        {
          id: "oct-bills",
          name: "October must-pays",
          dueOn: isoDate("2026-10-15"),
          remainingPaise: paiseOf(1_20_000),
          reservedPaise: paise(0),
          priority: "must_pay",
        },
      ],
      creditCards: [cardFixture({ id: "card-1" })],
      cardRules: [{ creditCardId: "card-1", rule: { statementDay: 25, dueDaysAfterStatement: 18 } }],
    });
    const result = simulateAffordability(snapshot, isoDate("2026-08-28"), {
      amountPaise: paiseOf(20_000),
      occurredOn: isoDate("2026-08-28"),
      funding: { creditCardId: "card-1" },
      meaning: "spend_card",
    });
    expect(result.horizonCycleIds.length).toBeGreaterThanOrEqual(2);
    expect(result.cycleProjections.some((item) => item.month === 9)).toBe(true);
    expect(result.cycleProjections.some((item) => item.month === 10)).toBe(true);
    const oct = result.cycleProjections.find((item) => item.month === 10);
    expect(oct?.projectedSafeToSpend).toBeLessThan(0);
    expect(result.conclusion.code).toBe("tight");
  });

  it("Q — delayed future cycle expected income is 0", () => {
    const snapshot = snapshotFixture({
      accounts: [accountFixture({ id: "hdfc", balancePaise: paiseOf(20_000) })],
      fundingCycles: [
        fundingCycleFixture({
          year: 2026,
          month: 8,
          actualArrivalOn: isoDate("2026-08-05"),
          actualAmountPaise: paiseOf(79_200),
          salaryEventId: "salary-aug",
        }),
      ],
    });
    const result = simulateAffordability(snapshot, isoDate("2026-09-10"), {
      amountPaise: paiseOf(1_000),
      occurredOn: isoDate("2026-09-10"),
      funding: { accountId: "hdfc" },
      meaning: "spend_account",
    });
    const sep = result.cycleProjections.find((item) => item.month === 9);
    expect(sep?.expectedIncome).toBe(0);
  });

  it("R — comfortable when current fits, buffer remains, and horizon is healthy", () => {
    const snapshot = capturedSnapshot();
    const result = simulateAffordability(snapshot, isoDate("2026-08-20"), {
      amountPaise: paiseOf(1_000),
      occurredOn: isoDate("2026-08-20"),
      funding: { accountId: "hdfc" },
      meaning: "spend_account",
    });
    expect(result.conclusion.code).toBe("comfortable");
    expect(result.currentBufferAfter).toBeGreaterThan(0);
  });

  it("S — tight when a later cycle is unhealthy", () => {
    const snapshot = snapshotFixture({
      accounts: [accountFixture({ id: "hdfc", balancePaise: paiseOf(31_000) })],
      fundingCycles: [
        fundingCycleFixture({
          year: 2026,
          month: 8,
          actualArrivalOn: isoDate("2026-08-05"),
          actualAmountPaise: paiseOf(79_200),
          salaryEventId: "salary-aug",
        }),
      ],
      extraObligations: [
        {
          id: "next",
          name: "Next-cycle bills",
          dueOn: isoDate("2026-09-20"),
          remainingPaise: paiseOf(98_000),
          reservedPaise: paise(0),
          priority: "must_pay",
        },
      ],
    });
    const result = simulateAffordability(snapshot, isoDate("2026-08-25"), {
      amountPaise: paiseOf(15_000),
      occurredOn: isoDate("2026-08-25"),
      funding: { accountId: "hdfc" },
      meaning: "spend_account",
    });
    expect(result.conclusion.currentFits).toBe(true);
    expect(result.conclusion.horizonHealthy).toBe(false);
    expect(result.conclusion.code).toBe("tight");
  });

  it("T — blocked when current STS would go negative", () => {
    const snapshot = capturedSnapshot();
    const result = simulateAffordability(snapshot, isoDate("2026-08-20"), {
      amountPaise: paiseOf(60_000),
      occurredOn: isoDate("2026-08-20"),
      funding: { accountId: "hdfc" },
      meaning: "spend_account",
    });
    expect(result.afterCurrent.currentCycleSafeToSpend).toBeLessThan(0);
    expect(result.conclusion.code).toBe("blocked");
  });
});

describe("evaluate vs simulation baseline", () => {
  it("uses the same engine result as the domain fixture", () => {
    const snapshot = capturedSnapshot();
    const asOf = isoDate("2026-08-20");
    const direct = evaluateSafeToSpend(snapshot, asOf);
    const simulated = simulateAffordability(snapshot, asOf, {
      amountPaise: paiseOf(100),
      occurredOn: asOf,
      funding: { accountId: "hdfc" },
      meaning: "spend_account",
    });
    expect(simulated.baseline.currentCycleSafeToSpend).toBe(direct.currentCycleSafeToSpend);
  });
});
