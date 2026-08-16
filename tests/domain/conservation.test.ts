import { describe, expect, it } from "vitest";
import { paise } from "../../src/domain/money/paise.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { newId } from "../../src/domain/ids.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { recordIncome } from "../../src/domain/commands/recordIncome.js";
import { recordExpense } from "../../src/domain/commands/recordExpense.js";
import { DomainError, type ProposedBatch } from "../../src/domain/ledger/types.js";
import { accountFixture, paiseOf, snapshotFixture } from "./fixtures.js";

const occurredOn = isoDate("2026-08-05");
const capturedAt = "2026-08-05T04:30:00.000Z";

function incomeBatch(accountDelta: number, incomeDelta: number): ProposedBatch {
  const eventId = newId();
  const accountId = newId();
  return {
    events: [
      {
        id: eventId,
        meaning: "income",
        occurredOn,
        capturedAt,
        amountPaise: paise(Math.abs(incomeDelta)),
        accountId,
        creditCardId: null,
        loanId: null,
        billingCycleId: null,
        fundingCycleId: null,
        obligationInstanceId: null,
        categoryId: null,
        channel: null,
        merchant: null,
        notes: null,
        reversalOfEventId: null,
      },
    ],
    postings: [
      {
        id: newId(),
        eventId,
        amountPaise: paise(accountDelta),
        accountId,
        creditCardId: null,
        loanId: null,
        pnl: null,
        categoryId: null,
        claimId: null,
        billingCycleId: null,
      },
      {
        id: newId(),
        eventId,
        amountPaise: paise(incomeDelta),
        accountId: null,
        creditCardId: null,
        loanId: null,
        pnl: "income_salary",
        categoryId: null,
        claimId: null,
        billingCycleId: null,
      },
    ],
    openings: [],
  };
}

describe("income conservation", () => {
  it("accepts account increase equal to income classification", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch, preview } = recordIncome(
      {
        occurredOn,
        capturedAt,
        amountPaise: paiseOf(79_200),
        accountId: account.id,
        kind: "salary",
      },
      snapshot,
    );
    expect(() => assertConservation("income", batch)).not.toThrow();
    expect(preview.narrative).toEqual([
      `${account.displayName} +₹79,200`,
      "Salary income +₹79,200",
    ]);
  });

  it("rejects mismatched income amounts", () => {
    expect(() => assertConservation("income", incomeBatch(7_920_000, 100))).toThrow(DomainError);
  });
});

describe("expense conservation", () => {
  it("accepts account decrease equal to one expense posting", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch, preview } = recordExpense(
      {
        occurredOn: isoDate("2026-08-10"),
        capturedAt,
        accountId: account.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(1_200) }],
      },
      snapshot,
    );
    expect(() => assertConservation("spend_account", batch)).not.toThrow();
    expect(preview.narrative).toEqual([
      `${account.displayName} −₹1,200`,
      "Grocery +₹1,200",
      "This counts toward your personal spending.",
    ]);
  });

  it("accepts one event with multiple expense-category postings", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordExpense(
      {
        occurredOn: isoDate("2026-08-10"),
        capturedAt,
        accountId: account.id,
        allocations: [
          { categoryId: "cat-grocery", amountPaise: paiseOf(1_800) },
          { categoryId: "cat-household", amountPaise: paiseOf(1_200) },
        ],
      },
      snapshot,
    );
    const accountDecrease = -batch.postings
      .filter((posting) => posting.accountId)
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    const expenseSum = batch.postings
      .filter((posting) => posting.pnl === "expense")
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(batch.events).toHaveLength(1);
    expect(batch.postings.filter((posting) => posting.pnl === "expense")).toHaveLength(2);
    expect(accountDecrease).toBe(300_000);
    expect(expenseSum).toBe(300_000);
    expect(() => assertConservation("spend_account", batch)).not.toThrow();
  });

  it("rejects expense that does not match the account decrease", () => {
    const eventId = newId();
    const accountId = newId();
    const batch: ProposedBatch = {
      events: [
        {
          id: eventId,
          meaning: "spend_account",
          occurredOn: isoDate("2026-08-10"),
          capturedAt,
          amountPaise: paiseOf(3_000),
          accountId,
          creditCardId: null,
          loanId: null,
          billingCycleId: null,
          fundingCycleId: null,
          obligationInstanceId: null,
          categoryId: null,
          channel: null,
          merchant: null,
          notes: null,
          reversalOfEventId: null,
        },
      ],
      postings: [
        {
          id: newId(),
          eventId,
          amountPaise: paise(-300_000),
          accountId,
          creditCardId: null,
          loanId: null,
          pnl: null,
          categoryId: null,
          claimId: null,
          billingCycleId: null,
        },
        {
          id: newId(),
          eventId,
          amountPaise: paise(180_000),
          accountId: null,
          creditCardId: null,
          loanId: null,
          pnl: "expense",
          categoryId: "cat-grocery",
          claimId: null,
          billingCycleId: null,
        },
      ],
      openings: [],
    };
    expect(() => assertConservation("spend_account", batch)).toThrow(/sum of personal expense/);
  });

  it("surplus resolution does not move cash, income, expense, or card liability", () => {
    const eventId = newId();
    const batch: ProposedBatch = {
      events: [
        {
          id: eventId,
          meaning: "surplus_resolution",
          occurredOn,
          capturedAt,
          amountPaise: paiseOf(50_000),
          accountId: newId(),
          creditCardId: null,
          loanId: null,
          billingCycleId: null,
          fundingCycleId: null,
          obligationInstanceId: null,
          categoryId: null,
          channel: null,
          merchant: null,
          notes: "Treat surplus as mine",
          reversalOfEventId: null,
        },
      ],
      postings: [],
      openings: [],
    };
    expect(() => assertConservation("surplus_resolution", batch)).not.toThrow();
    expect(() =>
      assertConservation("surplus_resolution", {
        ...batch,
        postings: [
          {
            id: newId(),
            eventId,
            amountPaise: paise(50_000),
            accountId: newId(),
            creditCardId: null,
            loanId: null,
            pnl: "income_other",
            categoryId: null,
            claimId: null,
            billingCycleId: null,
          },
        ],
      }),
    ).toThrow(/not income|does not move cash/);
  });
});
