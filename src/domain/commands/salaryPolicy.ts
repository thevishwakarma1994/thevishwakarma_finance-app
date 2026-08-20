import { isoDate, type IsoDate } from "../calendar/isoDate.js";
import { dayBefore, fundingCyclesCoveredByPolicy } from "../funding/cycles.js";
import { paise, type Paise } from "../money/paise.js";
import { newId } from "../ids.js";
import { DomainError, type FundingCycleRecord, type IncomePolicy } from "../ledger/types.js";

export type SalaryPolicyInput = {
  expectedAmountPaise: Paise;
  windowStartDay: number;
  typicalDay: number;
  windowEndDay: number;
  effectiveFrom: IsoDate;
};

export type SalaryPolicyVersionPlan = {
  close: { id: string; effectiveTo: IsoDate } | null;
  insert: IncomePolicy | null;
  update: IncomePolicy | null;
};

export function parseSalaryEffectiveFrom(value: string): IsoDate {
  try {
    return isoDate(value);
  } catch {
    throw new DomainError("invalid_salary_schedule", "Effective from must be a valid date");
  }
}

export function validateSalaryPolicyInput(input: {
  expectedAmountPaise: number;
  windowStartDay: number;
  typicalDay: number;
  windowEndDay: number;
}): void {
  if (!Number.isInteger(input.expectedAmountPaise) || input.expectedAmountPaise <= 0) {
    throw new DomainError("invalid_salary_schedule", "Expected salary must be greater than zero");
  }
  const { windowStartDay, typicalDay, windowEndDay } = input;
  if (
    !Number.isInteger(windowStartDay) ||
    !Number.isInteger(typicalDay) ||
    !Number.isInteger(windowEndDay) ||
    windowStartDay < 1 ||
    windowEndDay > 31 ||
    windowStartDay > typicalDay ||
    typicalDay > windowEndDay
  ) {
    throw new DomainError(
      "invalid_salary_schedule",
      "Arrival window must be 1 ≤ start ≤ typical day ≤ end ≤ 31",
    );
  }
}

export function planSalaryPolicyVersion(
  existing: IncomePolicy[],
  input: SalaryPolicyInput,
  persistedCycles: FundingCycleRecord[] = [],
): SalaryPolicyVersionPlan {
  validateSalaryPolicyInput(input);
  const sorted = [...existing].sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
  const sameStart = sorted.find((policy) => policy.effectiveFrom === input.effectiveFrom);
  if (sameStart) {
    if (fundingCyclesCoveredByPolicy(sameStart, persistedCycles).length > 0) {
      throw new DomainError(
        "policy_version_in_use",
        "This schedule already has expected salary periods. Choose a later effective-from date.",
      );
    }
    return {
      close: null,
      insert: null,
      update: {
        ...sameStart,
        expectedAmountPaise: paise(input.expectedAmountPaise),
        windowStartDay: input.windowStartDay,
        typicalDay: input.typicalDay,
        windowEndDay: input.windowEndDay,
      },
    };
  }

  const covering = sorted.find(
    (policy) =>
      policy.effectiveFrom < input.effectiveFrom &&
      (policy.effectiveTo === null || input.effectiveFrom <= policy.effectiveTo),
  );
  const next = sorted.find((policy) => policy.effectiveFrom > input.effectiveFrom);
  const closeTo = dayBefore(input.effectiveFrom);
  if (covering && closeTo < covering.effectiveFrom) {
    throw new DomainError("invalid_salary_schedule", "Effective from collides with the current schedule");
  }

  const inserted: IncomePolicy = {
    id: newId(),
    expectedAmountPaise: paise(input.expectedAmountPaise),
    windowStartDay: input.windowStartDay,
    typicalDay: input.typicalDay,
    windowEndDay: input.windowEndDay,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: next ? dayBefore(next.effectiveFrom) : null,
  };

  return {
    close: covering ? { id: covering.id, effectiveTo: closeTo } : null,
    insert: inserted,
    update: null,
  };
}
