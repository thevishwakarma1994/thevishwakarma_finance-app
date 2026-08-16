import { paise, sumPaise, type Paise } from "../money/paise.js";
import { newId } from "../ids.js";
import {
  DomainError,
  type ClaimKind,
  type ClaimRecord,
  type EventShare,
  type LedgerSnapshot,
  type PersonRecord,
  type Posting,
} from "../ledger/types.js";

export type PersonShareInput = {
  personId: string;
  amountPaise: Paise;
};

export function requireActivePerson(snapshot: LedgerSnapshot, personId: string): PersonRecord {
  const person = snapshot.people.find((item) => item.id === personId);
  if (!person) {
    throw new DomainError("person_not_found", "Person not found");
  }
  if (person.status !== "active") {
    throw new DomainError("person_archived", "This person is archived");
  }
  return person;
}

export function assertSharesMatchTotal(
  total: Paise,
  userSharePaise: Paise,
  personShares: PersonShareInput[],
): void {
  if (userSharePaise < 0) {
    throw new DomainError("invalid_shares", "User share cannot be negative");
  }
  if (personShares.length === 0) {
    throw new DomainError("invalid_shares", "At least one person share is required");
  }
  const seen = new Set<string>();
  for (const share of personShares) {
    if (share.amountPaise <= 0) {
      throw new DomainError("invalid_shares", "Each person share must be greater than zero");
    }
    if (seen.has(share.personId)) {
      throw new DomainError("invalid_shares", "Each person can appear only once");
    }
    seen.add(share.personId);
  }
  const shareTotal = paise(userSharePaise + sumPaise(personShares.map((share) => share.amountPaise)));
  if (shareTotal !== total) {
    throw new DomainError("invalid_shares", "Shares must sum exactly to the event total");
  }
}

export function buildEventShares(
  eventId: string,
  userSharePaise: Paise,
  personShares: PersonShareInput[],
): EventShare[] {
  return [
    {
      id: newId(),
      eventId,
      personId: null,
      amountPaise: userSharePaise,
      isUser: true,
    },
    ...personShares.map((share) => ({
      id: newId(),
      eventId,
      personId: share.personId,
      amountPaise: share.amountPaise,
      isUser: false,
    })),
  ];
}

export function buildUserOnlyShare(eventId: string, amountPaise: Paise): EventShare[] {
  return [
    {
      id: newId(),
      eventId,
      personId: null,
      amountPaise,
      isUser: true,
    },
  ];
}

export function buildReceivableClaim(input: {
  personId: string;
  kind: ClaimKind;
  amountPaise: Paise;
  originatingEventId: string | null;
  openingPositionId?: string | null;
  billingCycleId?: string | null;
  note?: string | null;
}): ClaimRecord {
  return {
    id: newId(),
    personId: input.personId,
    direction: "they_owe_user",
    kind: input.kind,
    originalAmountPaise: input.amountPaise,
    originatingEventId: input.originatingEventId,
    openingPositionId: input.openingPositionId ?? null,
    billingCycleId: input.billingCycleId ?? null,
    note: input.note ?? null,
    status: "open",
  };
}

export function buildPayableClaim(input: {
  personId: string;
  kind: ClaimKind;
  amountPaise: Paise;
  originatingEventId: string | null;
  openingPositionId?: string | null;
  note?: string | null;
}): ClaimRecord {
  return {
    id: newId(),
    personId: input.personId,
    direction: "user_owes_them",
    kind: input.kind,
    originalAmountPaise: input.amountPaise,
    originatingEventId: input.originatingEventId,
    openingPositionId: input.openingPositionId ?? null,
    billingCycleId: null,
    note: input.note ?? null,
    status: "open",
  };
}

export function claimIncreasePosting(
  eventId: string,
  claimId: string,
  amountPaise: Paise,
  billingCycleId: string | null = null,
): Posting {
  return {
    id: newId(),
    eventId,
    amountPaise,
    accountId: null,
    creditCardId: null,
    loanId: null,
    pnl: null,
    categoryId: null,
    claimId,
    billingCycleId,
  };
}
