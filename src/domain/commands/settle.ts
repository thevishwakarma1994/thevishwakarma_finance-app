import { paise, sumPaise, type Paise } from "../money/paise.js";
import { formatInr, formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import type { IsoDate } from "../calendar/isoDate.js";
import { claimIncreasePosting } from "./shares.js";
import {
  DomainError,
  type ClaimDirection,
  type ClaimStatusUpdate,
  type ConsequencePreview,
  type FinancialEvent,
  type LedgerClaim,
  type LedgerSnapshot,
  type PersonRecord,
  type ProposedBatch,
  type SettlementAllocation,
} from "../ledger/types.js";

export type ConfirmedAllocation = {
  claimId: string;
  amountPaise: Paise;
};

export type SettleInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  accountId: string;
  personId: string;
  amountPaise: Paise;
  allocations: ConfirmedAllocation[];
  notes?: string | null;
  channel?: string | null;
};

export function requirePerson(snapshot: LedgerSnapshot, personId: string): PersonRecord {
  const person = snapshot.people.find((item) => item.id === personId);
  if (!person) {
    throw new DomainError("person_not_found", "Person not found");
  }
  return person;
}

export function claimLabel(claim: LedgerClaim, snapshot: LedgerSnapshot): string {
  const event = claim.originatingEventId
    ? snapshot.events.find((item) => item.id === claim.originatingEventId)
    : undefined;
  if (claim.kind === "card_share") {
    const cycle = claim.billingCycleId
      ? snapshot.billingCycles.find((item) => item.id === claim.billingCycleId)
      : undefined;
    const card = cycle
      ? snapshot.creditCards.find((item) => item.id === cycle.creditCardId)
      : undefined;
    return card ? `${card.displayName} card share` : "Card share";
  }
  if (claim.kind === "shared_bill") {
    return event?.merchant ? `${event.merchant} split` : "Shared bill";
  }
  if (claim.kind === "direct_loan") return "Loan";
  if (claim.kind === "borrowing") return "Borrowing";
  if (claim.kind === "opening") return "Opening";
  return claim.kind;
}

export function assertConfirmedAllocations(
  snapshot: LedgerSnapshot,
  personId: string,
  amountPaise: Paise,
  allocations: ConfirmedAllocation[],
  expectedDirection: ClaimDirection,
): LedgerClaim[] {
  if (amountPaise <= 0) {
    throw new DomainError("invalid_amount", "Amount must be greater than zero");
  }
  if (allocations.length === 0) {
    throw new DomainError("invalid_allocation", "At least one allocation is required");
  }
  const seen = new Set<string>();
  const matched: LedgerClaim[] = [];
  for (const allocation of allocations) {
    if (allocation.amountPaise <= 0) {
      throw new DomainError("invalid_allocation", "Each allocation must be greater than zero");
    }
    if (seen.has(allocation.claimId)) {
      throw new DomainError("duplicate_allocation", "The same claim cannot be allocated twice");
    }
    seen.add(allocation.claimId);
    const claim = snapshot.claims.find((item) => item.id === allocation.claimId);
    if (!claim) {
      throw new DomainError("claim_not_found", "Claim not found");
    }
    if (claim.personId !== personId) {
      throw new DomainError("wrong_person", "This allocation belongs to a different person");
    }
    if (claim.direction !== expectedDirection) {
      throw new DomainError("wrong_direction", "This allocation is the wrong claim direction");
    }
    if (claim.status !== "open" || claim.openAmountPaise <= 0) {
      throw new DomainError("invalid_allocation", "This claim is not open");
    }
    if (allocation.amountPaise > claim.openAmountPaise) {
      throw new DomainError("allocation_exceeds_open", "Allocation cannot exceed the claim's open amount");
    }
    matched.push(claim);
  }
  const allocatedTotal = sumPaise(allocations.map((item) => item.amountPaise));
  if (allocatedTotal !== amountPaise) {
    throw new DomainError(
      "allocation_mismatch",
      allocatedTotal < amountPaise
        ? "Allocations must sum exactly to the settlement amount"
        : "Allocations cannot exceed the settlement amount",
    );
  }
  return matched;
}

export function buildSettlementBatch(input: {
  meaning: "settlement_in" | "settlement_out";
  settle: SettleInput;
  snapshot: LedgerSnapshot;
  claims: LedgerClaim[];
}): { batch: ProposedBatch; preview: ConsequencePreview } {
  const account = input.snapshot.accounts.find((item) => item.id === input.settle.accountId);
  if (!account || account.status !== "active") {
    throw new DomainError("account_not_found", "Account not found");
  }
  const person = requirePerson(input.snapshot, input.settle.personId);
  const incoming = input.meaning === "settlement_in";
  if (!incoming && input.settle.amountPaise > account.balancePaise) {
    throw new DomainError(
      "insufficient_balance",
      "This payment exceeds the money currently in the account",
    );
  }

  const eventId = newId();
  const event: FinancialEvent = {
    id: eventId,
    meaning: input.meaning,
    occurredOn: input.settle.occurredOn,
    capturedAt: input.settle.capturedAt,
    amountPaise: input.settle.amountPaise,
    accountId: account.id,
    creditCardId: null,
    loanId: null,
    billingCycleId: null,
    fundingCycleId: null,
    categoryId: null,
    channel: input.settle.channel ?? null,
    merchant: null,
    notes: input.settle.notes ?? null,
    reversalOfEventId: null,
  };

  const settlementAllocations: SettlementAllocation[] = input.settle.allocations.map((allocation) => ({
    id: newId(),
    eventId,
    claimId: allocation.claimId,
    amountPaise: allocation.amountPaise,
    createsReservation: false,
    reservationId: null,
  }));

  const claimStatusUpdates: ClaimStatusUpdate[] = input.settle.allocations.map((allocation, index) => {
    const claim = input.claims[index];
    if (!claim) {
      throw new DomainError("claim_not_found", "Claim not found");
    }
    const remaining = paise(claim.openAmountPaise - allocation.amountPaise);
    return {
      id: claim.id,
      status: remaining === paise(0) ? "settled" : "open",
    };
  });

  const accountDelta = incoming ? input.settle.amountPaise : paise(-input.settle.amountPaise);
  const batch: ProposedBatch = {
    events: [event],
    postings: [
      {
        id: newId(),
        eventId,
        amountPaise: accountDelta,
        accountId: account.id,
        creditCardId: null,
        loanId: null,
        pnl: null,
        categoryId: null,
        claimId: null,
        billingCycleId: null,
      },
      ...input.settle.allocations.map((allocation) =>
        claimIncreasePosting(eventId, allocation.claimId, paise(-allocation.amountPaise)),
      ),
    ],
    openings: [],
    settlementAllocations,
    claimStatusUpdates,
  };
  assertConservation(input.meaning, batch);

  const claimLines = input.settle.allocations.map((allocation, index) => {
    const claim = input.claims[index];
    const label = claim ? claimLabel(claim, input.snapshot) : "Claim";
    return `${formatInr(allocation.amountPaise)} → ${label}`;
  });

  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: account.displayName, deltaPaise: accountDelta },
      {
        kind: "claim",
        label: incoming ? `${person.name} owes you` : `You owe ${person.name}`,
        deltaPaise: paise(-input.settle.amountPaise),
      },
    ],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: [],
    narrative: incoming
      ? [
          `${account.displayName} ${formatInrDelta(accountDelta)}`,
          `${person.name} owes you ${formatInr(input.settle.amountPaise)} less`,
          "Income ₹0",
          ...claimLines,
        ]
      : [
          `${account.displayName} ${formatInrDelta(accountDelta)}`,
          `You owe ${person.name} ${formatInr(input.settle.amountPaise)} less`,
          "Personal spending ₹0",
          ...claimLines,
        ],
  };

  return { batch, preview };
}
