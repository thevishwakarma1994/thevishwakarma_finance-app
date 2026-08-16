import { paise, sumPaise, type Paise } from "../money/paise.js";
import { formatInr, formatInrDelta } from "../money/inr.js";
import { newId } from "../ids.js";
import { assertConservation } from "../conservation/validate.js";
import type { IsoDate } from "../calendar/isoDate.js";
import { claimIncreasePosting } from "./shares.js";
import { requireAvailable } from "../engine/liquidity.js";
import {
  buildReservation,
  buildUnallocatedSurplus,
  cycleCardLabel,
  reservationAmountForAllocation,
} from "../reservations/create.js";
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
  type ReservationRecord,
  type SettlementAllocation,
  type SurplusCaseRecord,
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
  if (claim.kind === "surplus_payable") return "Surplus payable";
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
  if (allocatedTotal > amountPaise) {
    throw new DomainError("allocation_mismatch", "Allocations cannot exceed the settlement amount");
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
  if (!incoming) {
    requireAvailable(input.snapshot, account.id, input.settle.amountPaise, "This payment");
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
    obligationInstanceId: null,
    categoryId: null,
    channel: input.settle.channel ?? null,
    merchant: null,
    notes: input.settle.notes ?? null,
    reversalOfEventId: null,
  };

  const reservedThisBatchByCycle = new Map<string, Paise>();
  const reservations: ReservationRecord[] = [];
  const settlementAllocations: SettlementAllocation[] = input.settle.allocations.map((allocation, index) => {
    const claim = input.claims[index];
    if (!claim) {
      throw new DomainError("claim_not_found", "Claim not found");
    }
    let reservationId: string | null = null;
    let createsReservation = false;
    if (incoming && claim.billingCycleId) {
      const reserveAmount = reservationAmountForAllocation(
        input.snapshot,
        claim,
        allocation.amountPaise,
        reservedThisBatchByCycle,
      );
      if (reserveAmount > 0) {
        const obligation = { type: "billing_cycle" as const, id: claim.billingCycleId };
        const reservation = buildReservation({
          sourceAccountId: account.id,
          amountPaise: reserveAmount,
          obligation,
          originatingEventId: eventId,
          originatingClaimId: claim.id,
          createdOn: input.settle.occurredOn,
        });
        reservations.push(reservation);
        reservationId = reservation.id;
        createsReservation = true;
        reservedThisBatchByCycle.set(
          obligation.id,
          paise((reservedThisBatchByCycle.get(obligation.id) ?? paise(0)) + reserveAmount),
        );
      }
    }
    return {
      id: newId(),
      eventId,
      claimId: allocation.claimId,
      amountPaise: allocation.amountPaise,
      createsReservation,
      reservationId,
    };
  });

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

  const allocatedTotal = sumPaise(input.settle.allocations.map((item) => item.amountPaise));
  const unallocated = paise(input.settle.amountPaise - allocatedTotal);
  const surplusCases: SurplusCaseRecord[] = [];
  if (unallocated > 0) {
    surplusCases.push(
      buildUnallocatedSurplus({
        amountPaise: unallocated,
        accountId: account.id,
        personId: person.id,
        eventId,
        personName: person.name,
        cashSittingInAccount: incoming,
      }),
    );
  }

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
    reservations,
    surplusCases,
  };
  assertConservation(input.meaning, batch);

  const reservedTotal = paise(
    reservations.reduce((sum, reservation) => sum + reservation.amountOriginalPaise, 0),
  );
  const claimLines = input.settle.allocations.map((allocation, index) => {
    const claim = input.claims[index];
    const label = claim ? claimLabel(claim, input.snapshot) : "Claim";
    const allocationRow = settlementAllocations[index];
    if (allocationRow?.createsReservation && claim?.billingCycleId) {
      return `${formatInr(allocation.amountPaise)} → ${label} · reserved for ${cycleCardLabel(input.snapshot, claim.billingCycleId)}`;
    }
    return `${formatInr(allocation.amountPaise)} → ${label}`;
  });
  const availableIncrease = incoming
    ? paise(input.settle.amountPaise - reservedTotal - unallocated)
    : paise(0);

  const preview: ConsequencePreview = {
    effects: [
      { kind: "account", label: account.displayName, deltaPaise: accountDelta },
      {
        kind: "claim",
        label: incoming ? `${person.name} owes you` : `You owe ${person.name}`,
        deltaPaise: paise(-allocatedTotal),
      },
      ...(reservedTotal > 0
        ? [{ kind: "reserved" as const, label: account.displayName, deltaPaise: reservedTotal }]
        : []),
      ...(unallocated > 0
        ? [{ kind: "surplus" as const, label: "Needs review", deltaPaise: unallocated }]
        : []),
    ],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: unallocated > 0 ? [`${formatInr(unallocated)} needs review`] : [],
    narrative: incoming
      ? [
          `${account.displayName} ${formatInrDelta(accountDelta)}`,
          `${person.name} owes you ${formatInr(allocatedTotal)} less`,
          reservedTotal > 0 ? `${formatInr(reservedTotal)} reserved` : null,
          availableIncrease > 0 ? `${formatInr(availableIncrease)} available` : null,
          unallocated > 0 ? `${formatInr(unallocated)} needs review` : null,
          "Income ₹0",
          ...claimLines,
        ].filter((line): line is string => Boolean(line))
      : [
          `${account.displayName} ${formatInrDelta(accountDelta)}`,
          `You owe ${person.name} ${formatInr(allocatedTotal)} less`,
          unallocated > 0 ? `${formatInr(unallocated)} needs review` : null,
          "Personal spending ₹0",
          ...claimLines,
        ].filter((line): line is string => Boolean(line)),
  };

  return { batch, preview };
}
