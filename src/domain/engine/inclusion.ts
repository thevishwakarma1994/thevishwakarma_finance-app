import type { IsoDate } from "../calendar/isoDate.js";
import { arrivalEffectiveAsOf, dayBefore } from "../funding/cycles.js";
import type { LedgerFundingCycle, ObligationPriority } from "../ledger/types.js";

export type InclusionContext = {
  asOf: IsoDate;
  cycles: LedgerFundingCycle[];
  active: LedgerFundingCycle | null;
  delayed: LedgerFundingCycle[];
  nextUnfailed: LedgerFundingCycle | null;
  openWindow: LedgerFundingCycle | null;
};

export type Q1Candidate = {
  dueOn: IsoDate;
  fundingCycleId: string | null;
  priority: ObligationPriority;
  remainingPaise: number;
};

export function q1Include(
  item: Q1Candidate,
  context: InclusionContext,
): { include: boolean; uncertainWindow: boolean } {
  if (item.priority === "planned" || item.remainingPaise <= 0) {
    return { include: false, uncertainWindow: false };
  }

  const overdue = item.dueOn <= context.asOf;
  const assignedToActive = Boolean(
    context.active && item.fundingCycleId === context.active.id,
  );

  if (context.delayed.length > 0) {
    const inOpenWindow = Boolean(
      context.openWindow &&
        context.openWindow.expectedWindowStart <= item.dueOn &&
        item.dueOn <= context.openWindow.expectedWindowEnd,
    );
    const coverThrough = context.nextUnfailed
      ? item.dueOn <= dayBefore(context.nextUnfailed.expectedWindowStart)
      : false;
    return {
      include: assignedToActive || overdue || inOpenWindow || coverThrough,
      uncertainWindow: inOpenWindow && !overdue && !assignedToActive,
    };
  }

  const next = context.nextUnfailed;
  const beforeNextWindow = next ? item.dueOn <= dayBefore(next.expectedWindowStart) : false;
  const insideNextWindow = Boolean(
    next &&
      !arrivalEffectiveAsOf(next, context.asOf) &&
      next.expectedWindowStart <= item.dueOn &&
      item.dueOn <= next.expectedWindowEnd,
  );
  return {
    include: assignedToActive || overdue || beforeNextWindow || insideNextWindow,
    uncertainWindow: insideNextWindow && !overdue && !assignedToActive,
  };
}
