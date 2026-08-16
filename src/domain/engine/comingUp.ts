import { paise, type Paise } from "../money/paise.js";
import { formatCardLabel, obligationRemainingForSTS } from "../cycle/lifecycle.js";
import { reservedToward } from "../reservations/derive.js";
import { remainingObligationPaise } from "../obligations/generate.js";
import { evaluateSafeToSpend } from "../engine/evaluateSafeToSpend.js";
import { assignFundingCycle } from "../funding/cycles.js";
import { kolkataAddDays } from "../calendar/kolkata.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { LedgerSnapshot, ObligationPriority } from "../ledger/types.js";

export const COMING_UP_FILTERS = [
  "next_10_days",
  "until_next_salary",
  "this_salary_period",
  "overdue",
  "all_open",
] as const;
export type ComingUpFilter = (typeof COMING_UP_FILTERS)[number];

export type ComingUpItem = {
  kind: "obligation" | "billing_cycle";
  id: string;
  name: string;
  dueOn: IsoDate;
  amountPaise: Paise;
  remainingPaise: Paise;
  reservedPaise: Paise;
  unfundedPaise: Paise;
  type: "obligation" | "card";
  priority: ObligationPriority;
  fundingCycleId: string | null;
  fundingPeriodLabel: string | null;
  status: string;
  overdue: boolean;
  uncertainWindow: boolean;
  delayedSalary: boolean;
  cardId: string | null;
  cycleId: string | null;
  instanceId: string | null;
};

export type ComingUpResult = {
  asOf: IsoDate;
  filter: ComingUpFilter;
  filterAvailable: boolean;
  filterUnavailableReason: string | null;
  items: ComingUpItem[];
};

function fundingLabel(
  snapshot: ReturnType<typeof evaluateSafeToSpend>,
  fundingCycleId: string | null,
): string | null {
  if (!fundingCycleId) return null;
  const cycle = snapshot.fundingCycles.find((item) => item.id === fundingCycleId);
  if (!cycle) return null;
  const month = String(cycle.month).padStart(2, "0");
  return `${cycle.year}-${month}`;
}

export function comingUpItems(snapshot: LedgerSnapshot, asOf: IsoDate): ComingUpItem[] {
  const sts = evaluateSafeToSpend(snapshot, asOf);
  const delayed = sts.delayedFundingCycleIds.length > 0;
  const items: ComingUpItem[] = [];

  for (const instance of snapshot.obligationInstances) {
    if (instance.status === "paid") continue;
    const remaining = remainingObligationPaise(instance);
    if (instance.status === "skipped" && remaining <= 0) {
      // skipped stays historically visible only when caller asks; default Coming Up is open
      continue;
    }
    if (instance.status !== "open") continue;
    const reservedPaise = reservedToward(snapshot.reservations, {
      type: "obligation_instance",
      id: instance.id,
    });
    const assigned = assignFundingCycle(sts.fundingCycles, instance.dueOn, asOf);
    const impact = [...sts.includedObligations, ...sts.excludedFutureObligations, ...sts.plannedNotSubtracted].find(
      (item) => item.ref.type === "obligation_instance" && item.ref.id === instance.id,
    );
    const unfunded = paise(Math.max(0, remaining - reservedPaise));
    items.push({
      kind: "obligation",
      id: instance.id,
      name: instance.nameSnapshot,
      dueOn: instance.dueOn,
      amountPaise: instance.amountPaise,
      remainingPaise: remaining,
      reservedPaise,
      unfundedPaise: unfunded,
      type: "obligation",
      priority: instance.prioritySnapshot,
      fundingCycleId: assigned?.id ?? null,
      fundingPeriodLabel: fundingLabel(sts, assigned?.id ?? null),
      status: instance.status,
      overdue: instance.dueOn <= asOf,
      uncertainWindow: impact?.uncertainWindow ?? false,
      delayedSalary: delayed && Boolean(impact?.includeInCurrentCycle),
      cardId: null,
      cycleId: null,
      instanceId: instance.id,
    });
  }

  for (const cycle of snapshot.billingCycles) {
    const remaining = obligationRemainingForSTS(cycle.ledgerRemainingPaise, cycle.statementRemainingPaise);
    if (remaining <= 0 && !cycle.mismatch) continue;
    const card = snapshot.creditCards.find((item) => item.id === cycle.creditCardId);
    const dueOn = cycle.actualDueOn ?? cycle.expectedDueOn;
    const reservedPaise = reservedToward(snapshot.reservations, { type: "billing_cycle", id: cycle.id });
    const assigned = assignFundingCycle(sts.fundingCycles, dueOn, asOf);
    const impact = sts.includedObligations
      .concat(sts.excludedFutureObligations)
      .find((item) => item.ref.type === "billing_cycle" && item.ref.id === cycle.id);
    const name = card ? formatCardLabel(card.displayName, card.mask) : "Card";
    items.push({
      kind: "billing_cycle",
      id: cycle.id,
      name,
      dueOn,
      amountPaise: remaining,
      remainingPaise: remaining,
      reservedPaise,
      unfundedPaise: paise(Math.max(0, remaining - reservedPaise)),
      type: "card",
      priority: "must_pay",
      fundingCycleId: assigned?.id ?? null,
      fundingPeriodLabel: fundingLabel(sts, assigned?.id ?? null),
      status: cycle.lifecycle,
      overdue: dueOn <= asOf,
      uncertainWindow: impact?.uncertainWindow ?? false,
      delayedSalary: delayed && Boolean(impact?.includeInCurrentCycle),
      cardId: cycle.creditCardId,
      cycleId: cycle.id,
      instanceId: null,
    });
  }

  return items.sort((left, right) => {
    if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
    const byDue = left.dueOn.localeCompare(right.dueOn);
    if (byDue !== 0) return byDue;
    return left.name.localeCompare(right.name);
  });
}

export function filterComingUp(
  items: ComingUpItem[],
  snapshot: LedgerSnapshot,
  asOf: IsoDate,
  filter: ComingUpFilter,
): ComingUpResult {
  const sts = evaluateSafeToSpend(snapshot, asOf);
  if (filter === "until_next_salary" && !sts.incomePolicyConfigured) {
    return {
      asOf,
      filter,
      filterAvailable: false,
      filterUnavailableReason: "Salary schedule not configured",
      items: [],
    };
  }
  if (filter === "this_salary_period" && !sts.activeFundingCycleId) {
    return {
      asOf,
      filter,
      filterAvailable: false,
      filterUnavailableReason: sts.incomePolicyConfigured
        ? "No active salary period yet"
        : "Salary schedule not configured",
      items: [],
    };
  }

  const horizon = kolkataAddDays(asOf, 10);
  const nextStart = sts.nextExpectedIncomeWindow.start;
  const filtered = items.filter((item) => {
    if (filter === "all_open") return true;
    if (filter === "overdue") return item.overdue;
    if (filter === "next_10_days") return item.dueOn >= asOf && item.dueOn <= horizon;
    if (filter === "until_next_salary") {
      if (!nextStart) return item.overdue;
      return item.dueOn < nextStart;
    }
    if (filter === "this_salary_period") {
      return item.fundingCycleId === sts.activeFundingCycleId || item.overdue;
    }
    return true;
  });

  return {
    asOf,
    filter,
    filterAvailable: true,
    filterUnavailableReason: null,
    items: filtered,
  };
}
