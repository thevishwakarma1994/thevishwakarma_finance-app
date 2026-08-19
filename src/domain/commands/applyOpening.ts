import { paise } from "../money/paise.js";
import { newId } from "../ids.js";
import {
  DomainError,
  type ClaimDirection,
  type ConsequencePreview,
  type LedgerSnapshot,
  type OpeningPosition,
  type ProposedBatch,
} from "../ledger/types.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import { formatInr } from "../money/inr.js";
import { buildPayableClaim, buildReceivableClaim, requireActivePerson } from "./shares.js";

export type ApplyAccountOpeningInput = {
  accountId: string;
  effectiveOn: IsoDate;
  balancePaise: Paise;
};

export type ApplyPersonOpeningInput = {
  personId: string;
  effectiveOn: IsoDate;
  direction: ClaimDirection;
  amountPaise: Paise;
  note?: string | null;
};

export type ApplyOpeningInput = ApplyAccountOpeningInput | ApplyPersonOpeningInput;

function isPersonOpening(input: ApplyOpeningInput): input is ApplyPersonOpeningInput {
  return "personId" in input;
}

export function applyOpening(
  input: ApplyOpeningInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  if (isPersonOpening(input)) {
    return applyPersonOpening(input, snapshot);
  }
  return applyAccountOpening(input, snapshot);
}

function applyAccountOpening(
  input: ApplyAccountOpeningInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const account = snapshot.accounts.find((item) => item.id === input.accountId);
  if (!account) {
    throw new DomainError("account_not_found", "Account not found");
  }
  if (snapshot.openings.some((opening) => opening.subjectId === input.accountId)) {
    throw new DomainError("opening_exists", "This account already has an opening position");
  }
  if (input.balancePaise < 0) {
    throw new DomainError("invalid_opening", "Opening balance cannot be negative");
  }

  const opening: OpeningPosition = {
    id: newId(),
    effectiveOn: input.effectiveOn,
    kind: "account",
    subjectId: input.accountId,
    payload: { balancePaise: input.balancePaise },
  };

  const preview: ConsequencePreview = {
    effects: [
      {
        kind: "opening",
        label: account.displayName,
        deltaPaise: input.balancePaise,
      },
    ],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: [],
    narrative: [
      `${account.displayName} opening ${formatInr(input.balancePaise)}`,
      "This is a starting balance, not income.",
    ],
  };

  return { batch: { events: [], postings: [], openings: [opening] }, preview };
}

function applyPersonOpening(
  input: ApplyPersonOpeningInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const person = requireActivePerson(snapshot, input.personId);
  if (snapshot.openings.some((opening) => opening.kind === "person" && opening.subjectId === input.personId)) {
    throw new DomainError("opening_exists", "This person already has an opening position");
  }
  if (input.amountPaise <= 0) {
    throw new DomainError("invalid_opening", "Opening amount must be greater than zero");
  }

  const opening: OpeningPosition = {
    id: newId(),
    effectiveOn: input.effectiveOn,
    kind: "person",
    subjectId: input.personId,
    payload: {
      direction: input.direction,
      amountPaise: input.amountPaise,
      note: input.note ?? null,
    },
  };
  const claim =
    input.direction === "they_owe_user"
      ? buildReceivableClaim({
          personId: person.id,
          kind: "direct_loan",
          amountPaise: input.amountPaise,
          originatingEventId: null,
          openingPositionId: opening.id,
          note: input.note,
        })
      : buildPayableClaim({
          personId: person.id,
          kind: "borrowing",
          amountPaise: input.amountPaise,
          originatingEventId: null,
          openingPositionId: opening.id,
          note: input.note,
        });

  const preview: ConsequencePreview = {
    effects: [
      {
        kind: "claim",
        label:
          input.direction === "they_owe_user"
            ? `${person.name} owes you`
            : `You owe ${person.name}`,
        deltaPaise: input.amountPaise,
      },
    ],
    classifications: {
      spent: paise(0),
      income: paise(0),
      invested: paise(0),
      moved: paise(0),
    },
    warnings: [],
    narrative: [
      input.direction === "they_owe_user"
        ? `${person.name} owes you ${formatInr(input.amountPaise)} as of ${input.effectiveOn}`
        : `You owe ${person.name} ${formatInr(input.amountPaise)} as of ${input.effectiveOn}`,
      "This is an opening position, not spending or income.",
    ],
  };

  return {
    batch: { events: [], postings: [], openings: [opening], claims: [claim] },
    preview,
  };
}
