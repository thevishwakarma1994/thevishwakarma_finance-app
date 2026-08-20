import { paise, sumPaise } from "../money/paise.js";
import { DomainError, type FinancialEvent, type LedgerSnapshot, type Posting } from "../ledger/types.js";
import { requireAvailable } from "../engine/liquidity.js";
import {
  correctionRootId,
  currentEffectiveLeafId,
  isCurrentEffectiveLeaf,
} from "./chain.js";
import type { CorrectionErrorCode } from "./types.js";

export type CorrectionFamily = "expense" | "other_income";

export type CorrectionIneligibilityReason =
  | "is_reversal"
  | "not_leaf"
  | "salary_income"
  | "card_spend"
  | "split"
  | "opening"
  | "linked_claim"
  | "reservation"
  | "settlement"
  | "obligation"
  | "surplus"
  | "funding_cycle"
  | "complex_postings"
  | "unsupported_family";

export type CorrectionEligibility =
  | { ok: true; family: CorrectionFamily }
  | {
      ok: false;
      code: Extract<
        CorrectionErrorCode,
        "transaction_not_correctable" | "stale_correction_target" | "unsupported_transaction_family"
      >;
      reason: CorrectionIneligibilityReason;
    };

function postingsFor(eventId: string, postings: readonly Posting[]): Posting[] {
  return postings.filter((posting) => posting.eventId === eventId);
}

function hasComplexLinkage(event: FinancialEvent, eventPostings: readonly Posting[], snapshot: LedgerSnapshot): boolean {
  if (
    event.creditCardId ||
    event.billingCycleId ||
    event.obligationInstanceId ||
    event.loanId
  ) {
    return true;
  }
  if (eventPostings.some((posting) => posting.creditCardId || posting.claimId || posting.billingCycleId)) {
    return true;
  }
  if (snapshot.eventShares.some((share) => share.eventId === event.id)) return true;
  if (snapshot.claims.some((claim) => claim.originatingEventId === event.id)) return true;
  if (snapshot.settlementAllocations.some((row) => row.eventId === event.id)) return true;
  if (snapshot.reservations.some((row) => row.originatingEventId === event.id)) return true;
  if (snapshot.reservationLedger.some((row) => row.eventId === event.id)) return true;
  if (snapshot.surplusCases.some((row) => row.eventId === event.id)) return true;
  if (snapshot.fundingCycles.some((cycle) => cycle.salaryEventId === event.id)) return true;
  if (event.fundingCycleId) return true;
  return false;
}

function complexReason(
  event: FinancialEvent,
  eventPostings: readonly Posting[],
  snapshot: LedgerSnapshot,
): CorrectionIneligibilityReason | null {
  if (event.meaning === "transaction_reversal" || event.reversalOfEventId) return "is_reversal";
  if (event.meaning.startsWith("apply_opening") || event.meaning.startsWith("correct_opening")) return "opening";
  if (event.meaning === "spend_card") return "card_spend";
  if (event.meaning === "split") return "split";
  if (event.meaning === "settlement_in" || event.meaning === "settlement_out") return "settlement";
  if (event.meaning === "pay_obligation") return "obligation";
  if (event.meaning === "surplus_resolution") return "surplus";
  if (snapshot.fundingCycles.some((cycle) => cycle.salaryEventId === event.id) || event.fundingCycleId) {
    return "funding_cycle";
  }
  if (snapshot.reservations.some((row) => row.originatingEventId === event.id)) return "reservation";
  if (snapshot.claims.some((claim) => claim.originatingEventId === event.id)) return "linked_claim";
  if (
    eventPostings.some((posting) => posting.claimId) ||
    snapshot.eventShares.some((share) => share.eventId === event.id)
  ) {
    return "linked_claim";
  }
  if (event.creditCardId || eventPostings.some((posting) => posting.creditCardId)) return "card_spend";
  if (hasComplexLinkage(event, eventPostings, snapshot)) return "complex_postings";
  return null;
}

function isSimpleExpense(event: FinancialEvent, eventPostings: readonly Posting[]): boolean {
  if (event.meaning !== "spend_account") return false;
  const accountSides = eventPostings.filter((posting) => posting.accountId);
  const expenseSides = eventPostings.filter((posting) => posting.pnl === "expense");
  if (accountSides.length !== 1 || expenseSides.length === 0) return false;
  const funded = accountSides[0]!;
  if (funded.amountPaise >= 0 || funded.pnl !== null) return false;
  if (expenseSides.some((posting) => posting.amountPaise <= 0 || posting.accountId)) return false;
  const expenseTotal = sumPaise(expenseSides.map((posting) => posting.amountPaise));
  return paise(-funded.amountPaise) === expenseTotal && eventPostings.length === accountSides.length + expenseSides.length;
}

function isSimpleOtherIncome(event: FinancialEvent, eventPostings: readonly Posting[]): boolean {
  if (event.meaning !== "income") return false;
  if (eventPostings.some((posting) => posting.pnl === "income_salary")) return false;
  const accountSides = eventPostings.filter((posting) => posting.accountId);
  const incomeSides = eventPostings.filter((posting) => posting.pnl === "income_other");
  if (accountSides.length !== 1 || incomeSides.length !== 1) return false;
  const funded = accountSides[0]!;
  const income = incomeSides[0]!;
  if (funded.amountPaise <= 0 || income.amountPaise <= 0) return false;
  if (funded.pnl !== null || income.accountId) return false;
  return (
    funded.amountPaise === income.amountPaise &&
    eventPostings.length === 2
  );
}

export function classifyCorrectionCandidate(
  event: FinancialEvent,
  snapshot: LedgerSnapshot,
): CorrectionEligibility {
  const eventPostings = postingsFor(event.id, snapshot.postings);
  if (event.meaning === "transaction_reversal" || event.reversalOfEventId) {
    return { ok: false, code: "transaction_not_correctable", reason: "is_reversal" };
  }
  if (!isCurrentEffectiveLeaf(snapshot.transactionCorrections, event.id)) {
    return { ok: false, code: "stale_correction_target", reason: "not_leaf" };
  }

  if (
    eventPostings.some((posting) => posting.pnl === "income_salary") ||
    snapshot.fundingCycles.some((cycle) => cycle.salaryEventId === event.id)
  ) {
    return { ok: false, code: "unsupported_transaction_family", reason: "salary_income" };
  }

  const linked = complexReason(event, eventPostings, snapshot);
  if (linked && linked !== "complex_postings") {
    const code =
      linked === "is_reversal"
        ? "transaction_not_correctable"
        : ("unsupported_transaction_family" as const);
    return { ok: false, code, reason: linked };
  }

  if (isSimpleExpense(event, eventPostings) && !linked) {
    return { ok: true, family: "expense" };
  }
  if (isSimpleOtherIncome(event, eventPostings) && !linked) {
    return { ok: true, family: "other_income" };
  }
  if (
    event.meaning === "spend_account" ||
    event.meaning === "income" ||
    event.meaning === "transfer" ||
    event.meaning === "lend" ||
    event.meaning === "borrow"
  ) {
    return { ok: false, code: "transaction_not_correctable", reason: "complex_postings" };
  }
  return { ok: false, code: "unsupported_transaction_family", reason: linked ?? "unsupported_family" };
}

export function assertCorrectionAvailability(
  snapshot: LedgerSnapshot,
  accountId: string,
  amountPaise: ReturnType<typeof paise>,
  action: string,
): void {
  try {
    requireAvailable(snapshot, accountId, amountPaise, action);
  } catch (caught) {
    if (caught instanceof DomainError && caught.code === "insufficient_available") {
      throw new DomainError(
        "correction_would_use_reserved_money",
        "This change would use money that is reserved or waiting for review",
      );
    }
    if (caught instanceof DomainError && caught.code === "insufficient_balance") {
      throw new DomainError("insufficient_available", "There is not enough money available in this account");
    }
    throw caught;
  }
}

export function assertEventIsCorrectableLeaf(snapshot: LedgerSnapshot, eventId: string): string {
  const rootEventId = correctionRootId(snapshot.transactionCorrections, eventId);
  const leafId = currentEffectiveLeafId(snapshot.transactionCorrections, rootEventId);
  if (leafId !== eventId) {
    throw new DomainError("stale_correction_target", "This transaction was already corrected");
  }
  return rootEventId;
}

export function expenseCorrectionRefusalCopy(reason: CorrectionIneligibilityReason): string {
  switch (reason) {
    case "linked_claim":
    case "reservation":
    case "settlement":
    case "obligation":
    case "surplus":
    case "split":
    case "card_spend":
    case "opening":
    case "funding_cycle":
    case "complex_postings":
      return "This transaction can’t be corrected because it has already affected another financial record.";
    case "not_leaf":
    case "is_reversal":
      return "This transaction was already corrected";
    default:
      return "This transaction can’t be corrected.";
  }
}

/** 16C1 expense correction only. Other-income stays foundation-only. */
export function assertEligibleExpenseCorrection(event: FinancialEvent, snapshot: LedgerSnapshot): void {
  const classified = classifyCorrectionCandidate(event, snapshot);
  if (!classified.ok) {
    if (classified.code === "stale_correction_target") {
      throw new DomainError("stale_correction_target", "This transaction was already corrected");
    }
    throw new DomainError("transaction_not_correctable", expenseCorrectionRefusalCopy(classified.reason));
  }
  if (classified.family !== "expense") {
    throw new DomainError("transaction_not_correctable", "This transaction can’t be corrected.");
  }
}
