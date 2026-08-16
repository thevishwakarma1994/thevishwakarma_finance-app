import { paise } from "../money/paise.js";
import { newId } from "../ids.js";
import {
  DomainError,
  type ConsequencePreview,
  type LedgerSnapshot,
  type OpeningPosition,
  type ProposedBatch,
} from "../ledger/types.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import { formatInr } from "../money/inr.js";

export type ApplyOpeningInput = {
  accountId: string;
  effectiveOn: IsoDate;
  balancePaise: Paise;
};

export function applyOpening(
  input: ApplyOpeningInput,
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
