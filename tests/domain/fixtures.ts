import { paise, type Paise } from "../../src/domain/money/paise.js";
import { newId } from "../../src/domain/ids.js";
import type {
  LedgerAccount,
  LedgerSnapshot,
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

export function snapshotFixture(overrides: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  const accounts = overrides.accounts ?? [accountFixture({ balancePaise: paiseOf(50_000) })];
  return {
    accounts,
    categories: overrides.categories ?? [
      { id: "cat-grocery", parentId: null, name: "Grocery" },
      { id: "cat-household", parentId: null, name: "Household" },
    ],
    events: overrides.events ?? [],
    postings: overrides.postings ?? [],
    openings: overrides.openings ?? [],
  };
}

export function emptyBatch(): ProposedBatch {
  return { events: [], postings: [], openings: [] };
}
