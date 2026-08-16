import { paise, type Paise } from "../../src/domain/money/paise.js";
import { newId } from "../../src/domain/ids.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import type {
  CreditCardRecord,
  LedgerAccount,
  LedgerBillingCycle,
  LedgerSnapshot,
  PersonRecord,
  ProposedBatch,
} from "../../src/domain/ledger/types.js";

export function paiseOf(rupees: number): Paise {
  return paise(Math.round(rupees * 100));
}

export function accountFixture(overrides: Partial<LedgerAccount> = {}): LedgerAccount {
  const opening = overrides.openingBalancePaise ?? paise(0);
  const posted = overrides.postedPaise ?? paise(0);
  return {
    id: overrides.id ?? newId(),
    kind: overrides.kind ?? "bank",
    displayName: overrides.displayName ?? "HDFC",
    mask: overrides.mask ?? "2581",
    isPrimarySalary: overrides.isPrimarySalary ?? true,
    status: overrides.status ?? "active",
    openingBalancePaise: opening,
    postedPaise: posted,
    balancePaise: overrides.balancePaise ?? paise(opening + posted),
  };
}

export function cardFixture(overrides: Partial<CreditCardRecord> = {}): CreditCardRecord {
  return {
    id: overrides.id ?? newId(),
    displayName: overrides.displayName ?? "ICICI",
    issuer: overrides.issuer ?? "ICICI",
    mask: overrides.mask ?? "8001",
    creditLimitPaise: overrides.creditLimitPaise ?? null,
    defaultPaymentAccountId: overrides.defaultPaymentAccountId ?? null,
    defaultOwnerPersonId: overrides.defaultOwnerPersonId ?? null,
    status: overrides.status ?? "active",
  };
}

export function cycleFixture(overrides: Partial<LedgerBillingCycle> = {}): LedgerBillingCycle {
  const expected = overrides.expectedAmountPaise ?? paise(0);
  const paid = overrides.amountPaidPaise ?? paise(0);
  const ledgerRemainingPaise = overrides.ledgerRemainingPaise ?? paise(expected - paid);
  const statementRemainingPaise =
    overrides.statementRemainingPaise ??
    paise((overrides.actualStatementAmountPaise ?? expected) - paid);
  const remaining = overrides.remainingPaise ?? paise(Math.min(ledgerRemainingPaise, statementRemainingPaise));
  return {
    id: overrides.id ?? newId(),
    creditCardId: overrides.creditCardId ?? newId(),
    purchaseWindowStart: overrides.purchaseWindowStart ?? isoDate("2026-08-13"),
    purchaseWindowEnd: overrides.purchaseWindowEnd ?? isoDate("2026-09-12"),
    expectedStatementOn: overrides.expectedStatementOn ?? isoDate("2026-09-12"),
    actualStatementOn: overrides.actualStatementOn ?? null,
    expectedDueOn: overrides.expectedDueOn ?? isoDate("2026-09-30"),
    actualDueOn: overrides.actualDueOn ?? null,
    actualStatementAmountPaise: overrides.actualStatementAmountPaise ?? null,
    ruleSnapshot: overrides.ruleSnapshot ?? { statementDay: 12, dueDaysAfterStatement: 18 },
    expectedAmountPaise: expected,
    amountPaidPaise: paid,
    ledgerRemainingPaise,
    statementRemainingPaise,
    remainingPaise: remaining,
    mismatch: overrides.mismatch ?? false,
    status: overrides.status ?? "open",
    lifecycle: overrides.lifecycle ?? "accumulating",
  };
}

export function personFixture(overrides: Partial<PersonRecord> = {}): PersonRecord {
  return {
    id: overrides.id ?? newId(),
    name: overrides.name ?? "Rahul",
    notes: overrides.notes ?? null,
    status: overrides.status ?? "active",
  };
}

export function snapshotFixture(overrides: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  const accounts = overrides.accounts ?? [accountFixture({ balancePaise: paiseOf(50_000) })];
  return {
    accounts,
    categories: overrides.categories ?? [
      { id: "cat-grocery", parentId: null, name: "Grocery", archivedAt: null },
      { id: "cat-household", parentId: null, name: "Household", archivedAt: null },
    ],
    creditCards: overrides.creditCards ?? [],
    people: overrides.people ?? [],
    billingCycles: overrides.billingCycles ?? [],
    claims: overrides.claims ?? [],
    eventShares: overrides.eventShares ?? [],
    events: overrides.events ?? [],
    postings: overrides.postings ?? [],
    openings: overrides.openings ?? [],
  };
}

export function emptyBatch(): ProposedBatch {
  return { events: [], postings: [], openings: [] };
}

export const ICICI_RULE = { statementDay: 12, dueDaysAfterStatement: 18 };
