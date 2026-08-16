import { assignBillingCycle, type CardCycleRule } from "./assign.js";
import { newId } from "../ids.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { BillingCycleRecord, LedgerBillingCycle } from "../ledger/types.js";

export function resolveBillingCycle(
  creditCardId: string,
  occurredOn: IsoDate,
  rule: CardCycleRule,
  existingCycles: LedgerBillingCycle[],
): { cycle: BillingCycleRecord; isNew: boolean } {
  const assigned = assignBillingCycle(occurredOn, rule);
  const existing = existingCycles.find(
    (cycle) =>
      cycle.creditCardId === creditCardId && cycle.expectedStatementOn === assigned.expectedStatementOn,
  );
  if (existing) {
    return {
      isNew: false,
      cycle: {
        id: existing.id,
        creditCardId: existing.creditCardId,
        purchaseWindowStart: existing.purchaseWindowStart,
        purchaseWindowEnd: existing.purchaseWindowEnd,
        expectedStatementOn: existing.expectedStatementOn,
        actualStatementOn: existing.actualStatementOn,
        expectedDueOn: existing.expectedDueOn,
        actualDueOn: existing.actualDueOn,
        actualStatementAmountPaise: existing.actualStatementAmountPaise,
        ruleSnapshot: existing.ruleSnapshot,
      },
    };
  }
  return {
    isNew: true,
    cycle: {
      id: newId(),
      creditCardId,
      purchaseWindowStart: assigned.purchaseWindowStart,
      purchaseWindowEnd: assigned.purchaseWindowEnd,
      expectedStatementOn: assigned.expectedStatementOn,
      actualStatementOn: null,
      expectedDueOn: assigned.expectedDueOn,
      actualDueOn: null,
      actualStatementAmountPaise: null,
      ruleSnapshot: assigned.ruleSnapshot,
    },
  };
}
