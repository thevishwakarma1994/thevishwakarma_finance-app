import { paise, type Paise } from "../money/paise.js";
import type { IsoDate } from "../calendar/isoDate.js";
import { q1Include } from "./inclusion.js";
import type { CycleProjection, ObligationImpact, SafeToSpendSnapshot } from "./types.js";
import type { LedgerFundingCycle } from "../ledger/types.js";
import {
  arrivalEffectiveAsOf,
  assignFundingCycle,
  compareYearMonth,
  expectedIncomeForProjection,
} from "../funding/cycles.js";

function unfundedAssignedTo(
  obligations: ObligationImpact[],
  cycleId: string,
): Paise {
  return paise(
    obligations
      .filter((item) => item.priority !== "planned" && item.fundingCycleId === cycleId)
      .reduce((sum, item) => sum + item.unfunded, 0),
  );
}

function unfundedBeforeArrival(
  obligations: ObligationImpact[],
  asOf: IsoDate,
  cycle: LedgerFundingCycle,
  inclusion: SafeToSpendSnapshot,
): Paise {
  const arrival = arrivalEffectiveAsOf(cycle, asOf)
    ? (cycle.actualArrivalOn as typeof cycle.expectedWindowStart)
    : cycle.expectedWindowStart;
  const context = {
    asOf,
    cycles: inclusion.fundingCycles,
    active: inclusion.fundingCycles.find((item) => item.id === inclusion.activeFundingCycleId) ?? null,
    delayed: inclusion.fundingCycles.filter((item) => item.status === "salary_delayed"),
    nextUnfailed:
      inclusion.fundingCycles.find((item) => item.id === inclusion.nextUnfailedCycleId) ?? null,
    openWindow:
      inclusion.fundingCycles.find(
        (item) =>
          !arrivalEffectiveAsOf(item, asOf) &&
          item.expectedWindowStart <= asOf &&
          asOf <= item.expectedWindowEnd,
      ) ?? null,
  };
  return paise(
    obligations
      .filter((item) => {
        if (item.priority === "planned" || item.unfunded <= 0) return false;
        if (item.fundingCycleId === cycle.id) return false;
        const decision = q1Include(
          {
            dueOn: item.dueOn,
            fundingCycleId: item.fundingCycleId,
            priority: item.priority,
            remainingPaise: item.grossRemaining,
          },
          context,
        );
        return decision.include && item.dueOn < arrival;
      })
      .reduce((sum, item) => sum + item.unfunded, 0),
  );
}

export function projectFundingCycle(input: {
  cycle: LedgerFundingCycle;
  carriedAvailable: Paise;
  after: SafeToSpendSnapshot;
  asOf: IsoDate;
}): CycleProjection {
  const allObligations = [
    ...input.after.includedObligations,
    ...input.after.excludedFutureObligations,
    ...input.after.plannedNotSubtracted,
  ];
  const expectedIncome = expectedIncomeForProjection(input.cycle);
  const beforeArrival = unfundedBeforeArrival(allObligations, input.asOf, input.cycle, input.after);
  const openingAvailableEstimate = paise(input.carriedAvailable - beforeArrival + expectedIncome);
  const includedUnfunded = unfundedAssignedTo(allObligations, input.cycle.id);
  return {
    fundingCycleId: input.cycle.id,
    year: input.cycle.year,
    month: input.cycle.month,
    openingAvailableEstimate,
    expectedIncome,
    includedUnfunded,
    projectedSafeToSpend: paise(openingAvailableEstimate - includedUnfunded),
  };
}

export function horizonCycles(
  after: SafeToSpendSnapshot,
  impactCycle: LedgerFundingCycle | null,
): LedgerFundingCycle[] {
  const active = after.fundingCycles.find((item) => item.id === after.activeFundingCycleId) ?? null;
  const immediateNext =
    after.fundingCycles
      .filter((cycle) => (active ? compareYearMonth(cycle, active) > 0 : true))
      .sort((left, right) => compareYearMonth(left, right))[0] ?? null;
  const nextUnfailed =
    after.fundingCycles.find((item) => item.id === after.nextUnfailedCycleId) ?? immediateNext;
  const candidates = [immediateNext, nextUnfailed, impactCycle].filter(
    (item): item is LedgerFundingCycle => Boolean(item),
  );
  const horizonEnd = candidates.sort((left, right) => compareYearMonth(right, left))[0];
  if (!horizonEnd) return [];
  return after.fundingCycles
    .filter((cycle) => {
      if (active && compareYearMonth(cycle, active) <= 0) return false;
      return compareYearMonth(cycle, horizonEnd) <= 0;
    })
    .sort((left, right) => compareYearMonth(left, right));
}

export function impactCycleForProposal(
  after: SafeToSpendSnapshot,
  meaning: "spend_account" | "spend_card",
  dueOn: IsoDate | null,
): LedgerFundingCycle | null {
  if (meaning !== "spend_card" || !dueOn) return null;
  return assignFundingCycle(after.fundingCycles, dueOn, after.asOf);
}
