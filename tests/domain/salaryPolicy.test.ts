import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import {
  planSalaryPolicyVersion,
  validateSalaryPolicyInput,
} from "../../src/domain/commands/salaryPolicy.js";
import {
  materializeFundingCycles,
  policyForSalaryMonth,
} from "../../src/domain/funding/cycles.js";
import { fundingCycleFixture, incomePolicyFixture } from "./fixtures.js";

describe("salary policy versioning", () => {
  it("accepts a 4/5/8 arrival window", () => {
    expect(() =>
      validateSalaryPolicyInput({
        expectedAmountPaise: 7_920_000,
        windowStartDay: 4,
        typicalDay: 5,
        windowEndDay: 8,
      }),
    ).not.toThrow();
  });

  it("rejects an invalid arrival window", () => {
    expect(() =>
      validateSalaryPolicyInput({
        expectedAmountPaise: 7_920_000,
        windowStartDay: 8,
        typicalDay: 5,
        windowEndDay: 4,
      }),
    ).toThrow(DomainError);
  });

  it("creates the first policy version", () => {
    const plan = planSalaryPolicyVersion([], {
      expectedAmountPaise: paise(7_920_000),
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: isoDate("2026-08-01"),
    });
    expect(plan.close).toBeNull();
    expect(plan.update).toBeNull();
    expect(plan.insert?.expectedAmountPaise).toBe(7_920_000);
    expect(plan.insert?.effectiveFrom).toBe("2026-08-01");
    expect(plan.insert?.effectiveTo).toBeNull();
  });

  it("closes the previous version the day before a later effective-from", () => {
    const current = incomePolicyFixture({
      id: "policy-aug",
      expectedAmountPaise: paise(7_920_000),
      effectiveFrom: isoDate("2026-08-01"),
      effectiveTo: null,
    });
    const plan = planSalaryPolicyVersion([current], {
      expectedAmountPaise: paise(8_200_000),
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: isoDate("2027-01-01"),
    });
    expect(plan.close).toEqual({ id: "policy-aug", effectiveTo: "2026-12-31" });
    expect(plan.insert?.expectedAmountPaise).toBe(8_200_000);
    expect(plan.insert?.effectiveFrom).toBe("2027-01-01");
    expect(plan.update).toBeNull();
  });

  it("updates in place when the effective-from date is unchanged and unused", () => {
    const current = incomePolicyFixture({
      id: "policy-aug",
      expectedAmountPaise: paise(7_920_000),
      effectiveFrom: isoDate("2026-08-01"),
    });
    const plan = planSalaryPolicyVersion([current], {
      expectedAmountPaise: paise(8_200_000),
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: isoDate("2026-08-01"),
    });
    expect(plan.close).toBeNull();
    expect(plan.insert).toBeNull();
    expect(plan.update?.id).toBe("policy-aug");
    expect(plan.update?.expectedAmountPaise).toBe(8_200_000);
  });

  it("rejects a same-effectiveFrom edit after a dependent cycle exists", () => {
    const current = incomePolicyFixture({
      id: "policy-aug",
      expectedAmountPaise: paise(7_920_000),
      effectiveFrom: isoDate("2026-08-01"),
    });
    try {
      planSalaryPolicyVersion(
        [current],
        {
          expectedAmountPaise: paise(8_200_000),
          windowStartDay: 4,
          typicalDay: 5,
          windowEndDay: 8,
          effectiveFrom: isoDate("2026-08-01"),
        },
        [fundingCycleFixture({ year: 2026, month: 8 })],
      );
      throw new Error("expected policy_version_in_use");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("policy_version_in_use");
    }
  });

  it("still versions a later effectiveFrom when historical cycles exist", () => {
    const current = incomePolicyFixture({
      id: "policy-aug",
      expectedAmountPaise: paise(7_920_000),
      effectiveFrom: isoDate("2026-08-01"),
    });
    const plan = planSalaryPolicyVersion(
      [current],
      {
        expectedAmountPaise: paise(8_200_000),
        windowStartDay: 4,
        typicalDay: 5,
        windowEndDay: 8,
        effectiveFrom: isoDate("2027-01-01"),
      },
      [fundingCycleFixture({ year: 2026, month: 8 }), fundingCycleFixture({ year: 2026, month: 9 })],
    );
    expect(plan.close).toEqual({ id: "policy-aug", effectiveTo: "2026-12-31" });
    expect(plan.insert?.effectiveFrom).toBe("2027-01-01");
  });
});

describe("V1 mid-month effectiveFrom eligibility", () => {
  const window = { windowStartDay: 4, typicalDay: 5, windowEndDay: 8 };

  it("applies to the current month when effectiveFrom is on or before month start", () => {
    const beforeWindow = incomePolicyFixture({
      ...window,
      id: "before-window",
      effectiveFrom: isoDate("2026-08-01"),
    });
    expect(policyForSalaryMonth([beforeWindow], 2026, 8)?.id).toBe("before-window");
    const cycles = materializeFundingCycles([beforeWindow], [], isoDate("2026-08-05"));
    expect(cycles.some((cycle) => cycle.year === 2026 && cycle.month === 8)).toBe(true);
  });

  it("skips the current month when effectiveFrom falls during the arrival window", () => {
    const during = incomePolicyFixture({
      ...window,
      id: "during-window",
      effectiveFrom: isoDate("2026-08-05"),
    });
    expect(policyForSalaryMonth([during], 2026, 8)).toBeNull();
    expect(policyForSalaryMonth([during], 2026, 9)?.id).toBe("during-window");
    const cycles = materializeFundingCycles([during], [], isoDate("2026-08-05"));
    expect(cycles.some((cycle) => cycle.year === 2026 && cycle.month === 8)).toBe(false);
    expect(cycles.some((cycle) => cycle.year === 2026 && cycle.month === 9)).toBe(true);
  });

  it("skips the current month when effectiveFrom is after the arrival window", () => {
    const after = incomePolicyFixture({
      ...window,
      id: "after-window",
      effectiveFrom: isoDate("2026-08-10"),
    });
    expect(policyForSalaryMonth([after], 2026, 8)).toBeNull();
    expect(policyForSalaryMonth([after], 2026, 9)?.id).toBe("after-window");
    const cycles = materializeFundingCycles([after], [], isoDate("2026-08-10"));
    expect(cycles.some((cycle) => cycle.year === 2026 && cycle.month === 8)).toBe(false);
    expect(cycles.some((cycle) => cycle.year === 2026 && cycle.month === 9)).toBe(true);
  });

  it("starts at February when effectiveFrom is 15 January", () => {
    const midJanuary = incomePolicyFixture({
      ...window,
      id: "jan-15",
      effectiveFrom: isoDate("2026-01-15"),
    });
    expect(policyForSalaryMonth([midJanuary], 2026, 1)).toBeNull();
    expect(policyForSalaryMonth([midJanuary], 2026, 2)?.id).toBe("jan-15");
    const cycles = materializeFundingCycles([midJanuary], [], isoDate("2026-01-15"));
    expect(cycles.some((cycle) => cycle.year === 2026 && cycle.month === 1)).toBe(false);
    expect(cycles.some((cycle) => cycle.year === 2026 && cycle.month === 2)).toBe(true);
  });
});
