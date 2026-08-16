import { paise, sumPaise, type Paise } from "../money/paise.js";
import {
  DomainError,
  type EventMeaning,
  type ProposedBatch,
} from "../ledger/types.js";

function accountDeltas(batch: ProposedBatch): Paise {
  return sumPaise(
    batch.postings
      .filter((posting) => posting.accountId)
      .map((posting) => posting.amountPaise),
  );
}

function pnlSum(batch: ProposedBatch, kind: ProposedBatch["postings"][number]["pnl"]): Paise {
  return sumPaise(
    batch.postings
      .filter((posting) => posting.pnl === kind)
      .map((posting) => posting.amountPaise),
  );
}

function cardDeltas(batch: ProposedBatch): Paise {
  return sumPaise(
    batch.postings
      .filter((posting) => posting.creditCardId)
      .map((posting) => posting.amountPaise),
  );
}

function surplusPortion(batch: ProposedBatch): Paise {
  return sumPaise((batch.surplusCases ?? []).map((item) => item.amountPaise));
}

function claimPortion(batch: ProposedBatch): Paise {
  return sumPaise(
    batch.postings
      .filter((posting) => posting.claimId && !posting.pnl && !posting.accountId && !posting.creditCardId)
      .map((posting) => posting.amountPaise),
  );
}

function expenseSum(batch: ProposedBatch): Paise {
  return pnlSum(batch, "expense");
}

function incomeSum(batch: ProposedBatch): Paise {
  return sumPaise([
    pnlSum(batch, "income_salary"),
    pnlSum(batch, "income_other"),
  ]);
}

export function assertConservation(
  meaning: EventMeaning,
  batch: ProposedBatch,
): void {
  const events = batch.events.filter((event) => event.meaning === meaning);
  if (events.length === 0 && meaning !== "income" && meaning !== "spend_account") {
    return;
  }

  if (meaning === "income") {
    const accountIncrease = accountDeltas(batch);
    const income = incomeSum(batch);
    if (accountIncrease !== income || accountIncrease <= 0) {
      throw new DomainError(
        "conservation_income",
        "Income must increase an account by the same amount as the income classification",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_income", "Income cannot create expense");
    }
    return;
  }

  if (meaning === "spend_account") {
    const accountDecrease = paise(-accountDeltas(batch));
    const expense = expenseSum(batch);
    if (accountDecrease !== expense || accountDecrease <= 0) {
      throw new DomainError(
        "conservation_expense",
        "Account decrease must equal the sum of personal expense postings",
      );
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_expense", "Expense cannot create income");
    }
    return;
  }

  if (meaning === "transfer") {
    const byAccount = batch.postings.filter((posting) => posting.accountId);
    const sourceDecrease = paise(
      -sumPaise(byAccount.filter((posting) => posting.amountPaise < 0).map((posting) => posting.amountPaise)),
    );
    const destinationIncrease = sumPaise(
      byAccount.filter((posting) => posting.amountPaise > 0).map((posting) => posting.amountPaise),
    );
    if (
      sourceDecrease !== destinationIncrease ||
      sourceDecrease <= 0 ||
      accountDeltas(batch) !== paise(0)
    ) {
      throw new DomainError(
        "conservation_transfer",
        "Source decrease must equal destination increase",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_transfer", "A transfer cannot create expense");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_transfer", "A transfer cannot create income");
    }
    return;
  }

  if (meaning === "spend_card") {
    const cardIncrease = cardDeltas(batch);
    const claims = claimPortion(batch);
    if (accountDeltas(batch) !== paise(0)) {
      throw new DomainError("conservation_card_spend", "A card purchase does not move bank or cash");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_card_spend", "A card purchase cannot create income");
    }
    if (cardIncrease <= 0) {
      throw new DomainError("conservation_card_spend", "Card liability must increase");
    }
    // Stage 8 recordCardSpend is 100% personal (claims = 0). Later the same
    // identity holds when claims are non-zero: card = personal expense + claims.
    if (cardIncrease !== paise(expenseSum(batch) + claims)) {
      throw new DomainError(
        "conservation_card_spend",
        "Card liability increase must equal personal expense plus claims",
      );
    }
    return;
  }

  if (meaning === "split") {
    const claims = claimPortion(batch);
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_split", "A split cannot create income");
    }
    const cardIncrease = cardDeltas(batch);
    if (cardIncrease !== paise(0)) {
      if (accountDeltas(batch) !== paise(0)) {
        throw new DomainError("conservation_split", "A card split does not move bank or cash");
      }
      if (cardIncrease <= 0) {
        throw new DomainError("conservation_split", "Card liability must increase");
      }
      if (cardIncrease !== paise(expenseSum(batch) + claims)) {
        throw new DomainError(
          "conservation_split",
          "Card liability increase must equal personal expense plus claims",
        );
      }
      return;
    }
    const accountDecrease = paise(-accountDeltas(batch));
    if (accountDecrease <= 0) {
      throw new DomainError("conservation_split", "Account must decrease");
    }
    if (accountDecrease !== paise(expenseSum(batch) + claims)) {
      throw new DomainError(
        "conservation_split",
        "Account decrease must equal personal expense plus claims",
      );
    }
    return;
  }

  if (meaning === "lend") {
    const accountDecrease = paise(-accountDeltas(batch));
    const claims = claimPortion(batch);
    if (accountDecrease !== claims || accountDecrease <= 0) {
      throw new DomainError(
        "conservation_lend",
        "Account decrease must equal the receivable claim increase",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_lend", "Lending is not personal spending");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_lend", "Lending is not income");
    }
    return;
  }

  if (meaning === "borrow") {
    const accountIncrease = accountDeltas(batch);
    const claims = claimPortion(batch);
    if (accountIncrease !== claims || accountIncrease <= 0) {
      throw new DomainError(
        "conservation_borrow",
        "Account increase must equal the payable claim increase",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_borrow", "Borrowing is not personal spending");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_borrow", "Borrowing is not income");
    }
    return;
  }

  if (meaning === "pay_obligation") {
    const accountDecrease = paise(-accountDeltas(batch));
    const cardDecrease = paise(-cardDeltas(batch));
    if (accountDecrease !== cardDecrease || accountDecrease <= 0) {
      throw new DomainError(
        "conservation_card_payment",
        "Account decrease must equal card liability decrease",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_card_payment", "A card payment is not personal spending");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_card_payment", "A card payment is not income");
    }
  }

  if (meaning === "settlement_in") {
    const accountIncrease = accountDeltas(batch);
    const claimDecrease = paise(-claimPortion(batch));
    const surplus = surplusPortion(batch);
    if (accountIncrease !== paise(claimDecrease + surplus) || accountIncrease <= 0) {
      throw new DomainError(
        "conservation_settlement_in",
        "Account increase must equal confirmed claim reductions plus unallocated surplus",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_settlement_in", "A settlement received is not personal spending");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_settlement_in", "A settlement received is not income");
    }
    if (cardDeltas(batch) !== paise(0)) {
      throw new DomainError("conservation_settlement_in", "Receiving a settlement does not change card liability");
    }
    return;
  }

  if (meaning === "settlement_out") {
    const accountDecrease = paise(-accountDeltas(batch));
    const claimDecrease = paise(-claimPortion(batch));
    const surplus = surplusPortion(batch);
    if (accountDecrease !== paise(claimDecrease + surplus) || accountDecrease <= 0) {
      throw new DomainError(
        "conservation_settlement_out",
        "Account decrease must equal confirmed payable reductions plus unallocated surplus",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_settlement_out", "Paying someone is not personal spending");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_settlement_out", "Paying someone is not income");
    }
    if (cardDeltas(batch) !== paise(0)) {
      throw new DomainError("conservation_settlement_out", "Paying someone does not change card liability");
    }
    return;
  }

  if (meaning === "surplus_resolution") {
    if (accountDeltas(batch) !== paise(0)) {
      throw new DomainError(
        "conservation_surplus_resolution",
        "Surplus resolution does not move cash unless a later supported resolution requires it",
      );
    }
    if (expenseSum(batch) !== paise(0)) {
      throw new DomainError("conservation_surplus_resolution", "Surplus resolution is not personal spending");
    }
    if (incomeSum(batch) !== paise(0)) {
      throw new DomainError("conservation_surplus_resolution", "Surplus resolution is not income");
    }
    if (cardDeltas(batch) !== paise(0)) {
      throw new DomainError("conservation_surplus_resolution", "Surplus resolution does not change card liability");
    }
    return;
  }
}

export function assertBatchConservation(batch: ProposedBatch): void {
  const meanings = [...new Set(batch.events.map((event) => event.meaning))];
  for (const meaning of meanings) {
    const slice: ProposedBatch = {
      events: batch.events.filter((event) => event.meaning === meaning),
      postings: batch.postings.filter((posting) =>
        sliceEventIds(batch, meaning).has(posting.eventId),
      ),
      openings: [],
      surplusCases: (batch.surplusCases ?? []).filter((item) =>
        item.eventId ? sliceEventIds(batch, meaning).has(item.eventId) : false,
      ),
    };
    assertConservation(meaning, slice);
  }
}

function sliceEventIds(batch: ProposedBatch, meaning: EventMeaning): Set<string> {
  return new Set(
    batch.events.filter((event) => event.meaning === meaning).map((event) => event.id),
  );
}
