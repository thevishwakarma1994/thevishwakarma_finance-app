import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import {
  planSalaryPolicyVersion,
  validateSalaryPolicyInput,
} from "../../src/domain/commands/salaryPolicy.js";
import { incomePolicyFixture } from "./fixtures.js";

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

  it("updates in place when the effective-from date is unchanged", () => {
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
});
