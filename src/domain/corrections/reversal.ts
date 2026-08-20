import { paise } from "../money/paise.js";
import { newId } from "../ids.js";
import { DomainError, type FinancialEvent, type Posting } from "../ledger/types.js";

export type ReversalBuild = {
  event: FinancialEvent;
  postings: Posting[];
};

function postingMatchesLinkage(left: Posting, right: Posting): boolean {
  return (
    left.accountId === right.accountId &&
    left.creditCardId === right.creditCardId &&
    left.loanId === right.loanId &&
    left.pnl === right.pnl &&
    left.categoryId === right.categoryId &&
    left.claimId === right.claimId &&
    left.billingCycleId === right.billingCycleId
  );
}

export function invertPosting(posting: Posting, eventId: string): Posting {
  return {
    ...posting,
    id: newId(),
    eventId,
    amountPaise: paise(-posting.amountPaise),
  };
}

export function buildTransactionReversal(
  target: FinancialEvent,
  targetPostings: readonly Posting[],
  capturedAt: string,
): ReversalBuild {
  if (target.meaning === "transaction_reversal") {
    throw new DomainError("transaction_not_correctable", "This transaction cannot be corrected");
  }
  const eligible = targetPostings.filter((posting) => posting.eventId === target.id);
  if (eligible.length === 0) {
    throw new DomainError("transaction_not_correctable", "This transaction cannot be corrected");
  }

  const eventId = newId();
  const event: FinancialEvent = {
    ...target,
    id: eventId,
    meaning: "transaction_reversal",
    capturedAt,
    reversalOfEventId: target.id,
  };
  const postings = eligible.map((posting) => invertPosting(posting, eventId));
  assertExactReversal(target, eligible, event, postings);
  return { event, postings };
}

export function assertExactReversal(
  target: FinancialEvent,
  targetPostings: readonly Posting[],
  reversal: FinancialEvent,
  reversalPostings: readonly Posting[],
): void {
  if (reversal.meaning !== "transaction_reversal") {
    throw new DomainError("conservation_reversal", "Reversal must use the transaction_reversal meaning");
  }
  if (reversal.reversalOfEventId !== target.id) {
    throw new DomainError("conservation_reversal", "Reversal must reference its target transaction");
  }
  const originals = targetPostings.filter((posting) => posting.eventId === target.id);
  const inverses = reversalPostings.filter((posting) => posting.eventId === reversal.id);
  if (originals.length === 0 || originals.length !== inverses.length) {
    throw new DomainError("conservation_reversal", "Reversal must invert every original amount");
  }

  const unmatched = [...originals];
  for (const inverse of inverses) {
    const index = unmatched.findIndex(
      (original) => postingMatchesLinkage(original, inverse) && original.amountPaise === paise(-inverse.amountPaise),
    );
    if (index < 0) {
      throw new DomainError("conservation_reversal", "Reversal must invert every original amount");
    }
    unmatched.splice(index, 1);
  }

  let combinedSum = 0;
  for (const posting of originals) combinedSum += posting.amountPaise;
  for (const posting of inverses) combinedSum += posting.amountPaise;
  if (combinedSum !== 0) {
    throw new DomainError("conservation_reversal", "Original and reversal together must net to zero");
  }
}
