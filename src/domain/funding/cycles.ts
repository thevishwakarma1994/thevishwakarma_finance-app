import { isoDate, isoDateParts, type IsoDate } from "../calendar/isoDate.js";
import { kolkataAddDays, kolkataAddMonths, kolkataCivilDate } from "../calendar/kolkata.js";
import { paise } from "../money/paise.js";
import { newId } from "../ids.js";
import type {
  FundingCycleRecord,
  FundingCycleStatus,
  IncomePolicy,
  LedgerFundingCycle,
} from "../ledger/types.js";

export function policyAsOf(policies: IncomePolicy[], asOf: IsoDate): IncomePolicy | null {
  return (
    policies
      .filter(
        (policy) =>
          policy.effectiveFrom <= asOf && (policy.effectiveTo === null || asOf <= policy.effectiveTo),
      )
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0] ?? null
  );
}

/** Month-start is the V1 eligibility instant for a salary cycle. */
export function salaryMonthStart(year: number, month: number): IsoDate {
  return isoDate(kolkataCivilDate(year, month, 1));
}

export function policyForSalaryMonth(
  policies: IncomePolicy[],
  year: number,
  month: number,
): IncomePolicy | null {
  return policyAsOf(policies, salaryMonthStart(year, month));
}

export function buildExpectedFundingCycle(
  policies: IncomePolicy[],
  year: number,
  month: number,
): FundingCycleRecord | null {
  const policy = policyForSalaryMonth(policies, year, month);
  if (!policy) return null;
  return buildFundingCycle(policy, year, month);
}

export function fundingCyclesCoveredByPolicy(
  policy: IncomePolicy,
  cycles: FundingCycleRecord[],
): FundingCycleRecord[] {
  return cycles.filter((cycle) => policyForSalaryMonth([policy], cycle.year, cycle.month)?.id === policy.id);
}

export function fundingWindow(policy: IncomePolicy, year: number, month: number): {
  start: IsoDate;
  end: IsoDate;
} {
  return {
    start: kolkataCivilDate(year, month, policy.windowStartDay),
    end: kolkataCivilDate(year, month, policy.windowEndDay),
  };
}

export function shiftYearMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const shifted = isoDateParts(kolkataAddMonths(kolkataCivilDate(year, month, 1), delta));
  return { year: shifted.year, month: shifted.month };
}

export function yearMonthOf(value: IsoDate): { year: number; month: number } {
  const parts = isoDateParts(value);
  return { year: parts.year, month: parts.month };
}

export function compareYearMonth(
  left: { year: number; month: number },
  right: { year: number; month: number },
): number {
  if (left.year !== right.year) return left.year - right.year;
  return left.month - right.month;
}

export function buildFundingCycle(
  policy: IncomePolicy,
  year: number,
  month: number,
  existing?: FundingCycleRecord,
): FundingCycleRecord {
  if (existing) return existing;
  const window = fundingWindow(policy, year, month);
  return {
    id: newId(),
    year,
    month,
    expectedWindowStart: window.start,
    expectedWindowEnd: window.end,
    expectedAmountSnapshot: policy.expectedAmountPaise,
    actualArrivalOn: null,
    actualAmountPaise: null,
    salaryEventId: null,
  };
}

export function materializeFundingCycles(
  policies: IncomePolicy[],
  persisted: FundingCycleRecord[],
  asOf: IsoDate,
  monthsBack = 2,
  monthsForward = 4,
): FundingCycleRecord[] {
  const origin = yearMonthOf(asOf);
  const latestArrived = persisted
    .filter((cycle) => arrivalEffectiveAsOf(cycle, asOf))
    .sort((left, right) => compareYearMonth(right, left))[0];
  const start = latestArrived
    ? { year: latestArrived.year, month: latestArrived.month }
    : shiftYearMonth(origin.year, origin.month, -monthsBack);
  const end = shiftYearMonth(origin.year, origin.month, monthsForward);
  const byKey = new Map(persisted.map((cycle) => [`${cycle.year}-${cycle.month}`, cycle]));
  const result: FundingCycleRecord[] = [...persisted];
  let cursor = start;
  while (compareYearMonth(cursor, end) <= 0) {
    const key = `${cursor.year}-${cursor.month}`;
    if (!byKey.has(key)) {
      const created = buildExpectedFundingCycle(policies, cursor.year, cursor.month);
      if (created) {
        byKey.set(key, created);
        result.push(created);
      }
    }
    cursor = shiftYearMonth(cursor.year, cursor.month, 1);
  }
  return result.sort((left, right) => compareYearMonth(left, right));
}

export function arrivalEffectiveAsOf(
  cycle: Pick<FundingCycleRecord, "actualArrivalOn">,
  asOf: IsoDate,
): boolean {
  return cycle.actualArrivalOn !== null && cycle.actualArrivalOn <= asOf;
}

export function deriveFundingCycleStatus(
  cycle: FundingCycleRecord,
  asOf: IsoDate,
  all: FundingCycleRecord[],
): FundingCycleStatus {
  if (arrivalEffectiveAsOf(cycle, asOf)) {
    const laterArrived = all.some(
      (item) => arrivalEffectiveAsOf(item, asOf) && compareYearMonth(item, cycle) > 0,
    );
    return laterArrived ? "closed" : "active";
  }
  if (asOf > cycle.expectedWindowEnd) return "salary_delayed";
  if (asOf >= cycle.expectedWindowStart) return "window_open_unreceived";
  return "upcoming";
}

export function enrichFundingCycles(
  cycles: FundingCycleRecord[],
  asOf: IsoDate,
): LedgerFundingCycle[] {
  return cycles.map((cycle) => ({
    ...cycle,
    status: deriveFundingCycleStatus(cycle, asOf, cycles),
  }));
}

export function reliableOrExpectedIncomeDate(
  cycle: FundingCycleRecord,
  asOf: IsoDate,
): IsoDate {
  return arrivalEffectiveAsOf(cycle, asOf)
    ? (cycle.actualArrivalOn as IsoDate)
    : cycle.expectedWindowStart;
}

export function assignFundingCycle(
  cycles: LedgerFundingCycle[],
  dueOn: IsoDate,
  asOf: IsoDate,
): LedgerFundingCycle | null {
  return (
    cycles
      .filter((cycle) => reliableOrExpectedIncomeDate(cycle, asOf) <= dueOn)
      .sort((left, right) => {
        const byDate = reliableOrExpectedIncomeDate(right, asOf).localeCompare(
          reliableOrExpectedIncomeDate(left, asOf),
        );
        if (byDate !== 0) return byDate;
        return compareYearMonth(right, left);
      })[0] ?? null
  );
}

export function activeFundingCycle(cycles: LedgerFundingCycle[]): LedgerFundingCycle | null {
  return (
    cycles
      .filter((cycle) => cycle.status === "active")
      .sort((left, right) => compareYearMonth(right, left))[0] ?? null
  );
}

export function delayedFundingCycles(cycles: LedgerFundingCycle[]): LedgerFundingCycle[] {
  const active = activeFundingCycle(cycles);
  return cycles.filter((cycle) => {
    if (cycle.status !== "salary_delayed") return false;
    if (!active) return true;
    return compareYearMonth(cycle, active) > 0;
  });
}

export function openWindowCycle(
  cycles: LedgerFundingCycle[],
  asOf: IsoDate,
): LedgerFundingCycle | null {
  return (
    cycles.find(
      (cycle) =>
        !arrivalEffectiveAsOf(cycle, asOf) &&
        cycle.expectedWindowStart <= asOf &&
        asOf <= cycle.expectedWindowEnd,
    ) ?? null
  );
}

export function nextUnfailedCycle(
  cycles: LedgerFundingCycle[],
  asOf: IsoDate,
): LedgerFundingCycle | null {
  return (
    cycles
      .filter((cycle) => !arrivalEffectiveAsOf(cycle, asOf) && asOf <= cycle.expectedWindowEnd)
      .sort((left, right) => compareYearMonth(left, right))[0] ?? null
  );
}

export function immediateNextFundingCycle(
  cycles: LedgerFundingCycle[],
): LedgerFundingCycle | null {
  const active = activeFundingCycle(cycles);
  if (!active) {
    return cycles.sort((left, right) => compareYearMonth(left, right))[0] ?? null;
  }
  return (
    cycles
      .filter((cycle) => compareYearMonth(cycle, active) > 0)
      .sort((left, right) => compareYearMonth(left, right))[0] ?? null
  );
}

export function dayBefore(value: IsoDate): IsoDate {
  return kolkataAddDays(value, -1);
}

export function expectedIncomeForProjection(cycle: LedgerFundingCycle): typeof cycle.expectedAmountSnapshot {
  if (cycle.status === "salary_delayed") return paise(0);
  return cycle.expectedAmountSnapshot;
}

export function typicalOnForCycle(
  cycle: Pick<FundingCycleRecord, "year" | "month" | "expectedWindowStart">,
  policy: IncomePolicy | null,
): IsoDate {
  const day = policy?.typicalDay ?? isoDateParts(cycle.expectedWindowStart).day;
  return kolkataCivilDate(cycle.year, cycle.month, day);
}
