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
    };
    assertConservation(meaning, slice);
  }
}

function sliceEventIds(batch: ProposedBatch, meaning: EventMeaning): Set<string> {
  return new Set(
    batch.events.filter((event) => event.meaning === meaning).map((event) => event.id),
  );
}
