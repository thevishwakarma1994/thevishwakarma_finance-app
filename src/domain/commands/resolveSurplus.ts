import { paise, type Paise } from "../money/paise.js";
import { formatInr } from "../money/inr.js";
import { utcNowIso } from "../calendar/kolkata.js";
import type { IsoDate } from "../calendar/isoDate.js";
import { DomainError } from "../ledger/types.js";
import type {
  ClaimRecord,
  ConsequencePreview,
  FinancialEvent,
  LedgerSnapshot,
  ProposedBatch,
  ReservationLedgerEntry,
  ReservationMutation,
  ReservationRecord,
  SettlementAllocation,
  SurplusCaseRecord,
  SurplusCaseUpdate,
  SurplusResolution,
} from "../ledger/types.js";
import { newId } from "../ids.js";
import { applyReservationDelta } from "../reservations/derive.js";
import {
  buildReservation,
  cycleCardLabel,
  obligationForCardLinkedClaim,
  unfundedForCycle,
} from "../reservations/create.js";
import { assertConservation } from "../conservation/validate.js";

export type ResolveSurplusInput = {
  occurredOn: IsoDate;
  capturedAt: string;
  surplusCaseId: string;
  resolution: SurplusResolution;
  amountPaise?: Paise;
  claimId?: string;
  billingCycleId?: string;
  confirmed?: boolean;
};

function pendingSurplus(snapshot: LedgerSnapshot, surplusCaseId: string): SurplusCaseRecord {
  const item = snapshot.surplusCases.find((row) => row.id === surplusCaseId);
  if (!item) {
    throw new DomainError("surplus_not_found", "Surplus case not found");
  }
  if (item.status !== "pending") {
    throw new DomainError("surplus_not_pending", "This surplus is already resolved");
  }
  return item;
}

function applyAmount(item: SurplusCaseRecord, requested: Paise | undefined): Paise {
  const amount = requested ?? item.amountPaise;
  if (amount <= 0) {
    throw new DomainError("invalid_amount", "Amount must be greater than zero");
  }
  if (amount > item.amountPaise) {
    throw new DomainError("invalid_amount", "Cannot apply more than the pending surplus");
  }
  return amount;
}

function surplusUpdate(
  item: SurplusCaseRecord,
  remaining: Paise,
  resolution: SurplusResolution,
  resolvedByEventId: string,
): SurplusCaseUpdate {
  if (remaining > 0) {
    return {
      id: item.id,
      amountPaise: remaining,
      status: "pending",
      resolution: null,
      resolvedAt: null,
      resolvedByEventId: null,
    };
  }
  return {
    id: item.id,
    amountPaise: item.amountPaise,
    status: "resolved",
    resolution,
    resolvedAt: utcNowIso(),
    resolvedByEventId,
  };
}

function buildResolutionEvent(input: {
  occurredOn: IsoDate;
  capturedAt: string;
  amountPaise: Paise;
  accountId: string | null;
  notes: string;
}): FinancialEvent {
  return {
    id: newId(),
    meaning: "surplus_resolution",
    occurredOn: input.occurredOn,
    capturedAt: input.capturedAt,
    amountPaise: input.amountPaise,
    accountId: input.accountId,
    creditCardId: null,
    loanId: null,
    billingCycleId: null,
    fundingCycleId: null,
    categoryId: null,
    channel: null,
    merchant: null,
    notes: input.notes,
    reversalOfEventId: null,
  };
}

function convertHeld(
  snapshot: LedgerSnapshot,
  item: SurplusCaseRecord,
  amountPaise: Paise,
  eventId: string,
  createdAt: string,
  to: "released" | "reassigned",
): { updates: ReservationMutation[]; ledger: ReservationLedgerEntry[] } {
  if (!item.reservationId) {
    return { updates: [], ledger: [] };
  }
  const reservation = snapshot.reservations.find((row) => row.id === item.reservationId);
  if (!reservation) {
    throw new DomainError("reservation_not_found", "Reservation not found");
  }
  const take = paise(Math.min(amountPaise, reservation.amountSurplusHeldPaise));
  if (take <= 0) {
    return { updates: [], ledger: [] };
  }
  const mutated = applyReservationDelta(reservation, eventId, createdAt, {
    released: to === "released" ? take : paise(0),
    reassigned: to === "reassigned" ? take : paise(0),
    surplusHeld: paise(-take),
  });
  return { updates: [mutated.update], ledger: [mutated.ledger] };
}

function withResolutionEvent(
  event: FinancialEvent,
  rest: Omit<ProposedBatch, "events" | "postings" | "openings">,
): ProposedBatch {
  const batch: ProposedBatch = {
    events: [event],
    postings: [],
    openings: [],
    ...rest,
  };
  assertConservation("surplus_resolution", batch);
  return batch;
}

export function resolveSurplus(
  input: ResolveSurplusInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const item = pendingSurplus(snapshot, input.surplusCaseId);
  const amountPaise = applyAmount(item, input.amountPaise);
  const remaining = paise(item.amountPaise - amountPaise);
  const createdAt = input.capturedAt;

  if (input.resolution === "treat_as_mine_correction") {
    if (!input.confirmed) {
      throw new DomainError(
        "confirmation_required",
        `This will treat ${formatInr(amountPaise)} as your money`,
      );
    }
    if (!item.sourceAccountId) {
      throw new DomainError(
        "unsupported_resolution",
        "Treat as mine is only for cash still sitting in an account",
      );
    }
    const event = buildResolutionEvent({
      occurredOn: input.occurredOn,
      capturedAt: input.capturedAt,
      amountPaise,
      accountId: item.sourceAccountId,
      notes: "Treat surplus as mine",
    });
    const hold = convertHeld(snapshot, item, amountPaise, event.id, createdAt, "released");
    return {
      batch: withResolutionEvent(event, {
        reservationUpdates: hold.updates,
        reservationLedger: hold.ledger,
        surplusCaseUpdates: [surplusUpdate(item, remaining, input.resolution, event.id)],
      }),
      preview: {
        effects: [{ kind: "surplus", label: "Treat as mine", deltaPaise: paise(-amountPaise) }],
        classifications: { spent: paise(0), income: paise(0), invested: paise(0), moved: paise(0) },
        warnings: [`This treats ${formatInr(amountPaise)} as your money. It is not recorded as income.`],
        narrative: [`${formatInr(amountPaise)} is now available`, "No income was recorded"],
      },
    };
  }

  if (input.resolution === "convert_to_payable") {
    if (!item.personId) {
      throw new DomainError("unsupported_resolution", "This surplus is not linked to a person");
    }
    const person = snapshot.people.find((row) => row.id === item.personId);
    const event = buildResolutionEvent({
      occurredOn: input.occurredOn,
      capturedAt: input.capturedAt,
      amountPaise,
      accountId: item.sourceAccountId,
      notes: "Convert surplus to payable",
    });
    const claim: ClaimRecord = {
      id: newId(),
      personId: item.personId,
      direction: "user_owes_them",
      kind: "surplus_payable",
      originalAmountPaise: amountPaise,
      originatingEventId: event.id,
      openingPositionId: null,
      billingCycleId: null,
      note: "Converted from surplus",
      status: "open",
    };
    const hold = convertHeld(snapshot, item, amountPaise, event.id, createdAt, "released");
    return {
      batch: withResolutionEvent(event, {
        claims: [claim],
        reservationUpdates: hold.updates,
        reservationLedger: hold.ledger,
        surplusCaseUpdates: [surplusUpdate(item, remaining, input.resolution, event.id)],
      }),
      preview: {
        effects: [
          { kind: "claim", label: `You owe ${person?.name ?? "them"}`, deltaPaise: amountPaise },
          { kind: "surplus", label: "Converted to payable", deltaPaise: paise(-amountPaise) },
        ],
        classifications: { spent: paise(0), income: paise(0), invested: paise(0), moved: paise(0) },
        warnings: [],
        narrative: [
          `Created a payable of ${formatInr(amountPaise)} to ${person?.name ?? "them"}`,
          item.sourceAccountId ? `${formatInr(amountPaise)} is now available` : "No cash movement",
          "Not income or spending",
        ],
      },
    };
  }

  if (input.resolution === "apply_to_other_claim") {
    if (!input.claimId) {
      throw new DomainError("claim_not_found", "Choose a claim to apply this surplus to");
    }
    const claim = snapshot.claims.find((row) => row.id === input.claimId);
    if (!claim) {
      throw new DomainError("claim_not_found", "Claim not found");
    }
    if (item.personId && claim.personId !== item.personId) {
      throw new DomainError("wrong_person", "This claim belongs to a different person");
    }
    const incoming = Boolean(item.sourceAccountId);
    const expectedDirection = incoming ? "they_owe_user" : "user_owes_them";
    if (claim.direction !== expectedDirection) {
      throw new DomainError("wrong_direction", "This claim is the wrong direction for this surplus");
    }
    if (claim.status !== "open" || claim.openAmountPaise <= 0) {
      throw new DomainError("invalid_allocation", "This claim is not open");
    }
    if (amountPaise > claim.openAmountPaise) {
      throw new DomainError("allocation_exceeds_open", "Allocation cannot exceed the claim's open amount");
    }

    const event = buildResolutionEvent({
      occurredOn: input.occurredOn,
      capturedAt: input.capturedAt,
      amountPaise,
      accountId: item.sourceAccountId,
      notes: "Apply surplus to another claim",
    });
    const reservations: ReservationRecord[] = [];
    const obligation = obligationForCardLinkedClaim(snapshot, claim);
    let createsReservation = false;
    let reservationId: string | null = null;
    if (incoming && obligation && item.sourceAccountId) {
      const reserveAmount = paise(Math.min(amountPaise, unfundedForCycle(snapshot, obligation.id)));
      if (reserveAmount > 0) {
        const reservation = buildReservation({
          sourceAccountId: item.sourceAccountId,
          amountPaise: reserveAmount,
          obligation,
          originatingEventId: event.id,
          originatingClaimId: claim.id,
          createdOn: input.occurredOn,
        });
        reservations.push(reservation);
        reservationId = reservation.id;
        createsReservation = true;
      }
    }
    const settlementAllocations: SettlementAllocation[] = [
      {
        id: newId(),
        eventId: event.id,
        claimId: claim.id,
        amountPaise,
        createsReservation,
        reservationId,
      },
    ];
    return {
      batch: withResolutionEvent(event, {
        settlementAllocations,
        reservations,
        claimStatusUpdates: [
          {
            id: claim.id,
            status: paise(claim.openAmountPaise - amountPaise) === paise(0) ? "settled" : "open",
          },
        ],
        surplusCaseUpdates: [surplusUpdate(item, remaining, input.resolution, event.id)],
      }),
      preview: {
        effects: [
          { kind: "claim", label: "Claim", deltaPaise: paise(-amountPaise) },
          ...(createsReservation && obligation
            ? [{ kind: "reserved" as const, label: cycleCardLabel(snapshot, obligation.id), deltaPaise: amountPaise }]
            : []),
        ],
        classifications: { spent: paise(0), income: paise(0), invested: paise(0), moved: paise(0) },
        warnings: [],
        narrative: [
          `Applied ${formatInr(amountPaise)} to another claim`,
          createsReservation && obligation
            ? `${formatInr(amountPaise)} reserved for ${cycleCardLabel(snapshot, obligation.id)}`
            : null,
        ].filter((line): line is string => Boolean(line)),
      },
    };
  }

  if (input.resolution === "reassign_reservation") {
    if (item.kind !== "reservation_excess") {
      throw new DomainError("unsupported_resolution", "Reassign is only for reservation excess");
    }
    if (!input.billingCycleId) {
      throw new DomainError("cycle_not_found", "Choose an unpaid billing cycle");
    }
    const cycle = snapshot.billingCycles.find((row) => row.id === input.billingCycleId);
    if (!cycle) {
      throw new DomainError("cycle_not_found", "Billing cycle not found");
    }
    if (cycle.remainingPaise <= 0) {
      throw new DomainError("unsupported_resolution", "That cycle is already paid");
    }
    if (!item.reservationId || !item.sourceAccountId) {
      throw new DomainError("reservation_not_found", "Reservation not found");
    }
    const source = snapshot.reservations.find((row) => row.id === item.reservationId);
    if (!source) {
      throw new DomainError("reservation_not_found", "Reservation not found");
    }
    const take = paise(
      Math.min(amountPaise, source.amountSurplusHeldPaise, unfundedForCycle(snapshot, cycle.id)),
    );
    if (take <= 0) {
      throw new DomainError("invalid_reservation", "Nothing can be reassigned to that cycle");
    }
    const event = buildResolutionEvent({
      occurredOn: input.occurredOn,
      capturedAt: input.capturedAt,
      amountPaise: take,
      accountId: item.sourceAccountId,
      notes: "Reassign reservation",
    });
    const hold = convertHeld(snapshot, item, take, event.id, createdAt, "reassigned");
    const target = buildReservation({
      sourceAccountId: item.sourceAccountId,
      amountPaise: take,
      obligation: { type: "billing_cycle", id: cycle.id },
      originatingEventId: event.id,
      originatingClaimId: source.originatingClaimId,
      createdOn: input.occurredOn,
    });
    const leftover = paise(item.amountPaise - take);
    return {
      batch: withResolutionEvent(event, {
        reservations: [target],
        reservationUpdates: hold.updates,
        reservationLedger: hold.ledger,
        surplusCaseUpdates: [surplusUpdate(item, leftover, input.resolution, event.id)],
      }),
      preview: {
        effects: [{ kind: "reserved", label: cycleCardLabel(snapshot, cycle.id), deltaPaise: take }],
        classifications: { spent: paise(0), income: paise(0), invested: paise(0), moved: paise(0) },
        warnings: [],
        narrative: [`Reassigned ${formatInr(take)} to ${cycleCardLabel(snapshot, cycle.id)}`, "No cash movement"],
      },
    };
  }

  throw new DomainError("unsupported_resolution", "That surplus resolution is not available yet");
}
