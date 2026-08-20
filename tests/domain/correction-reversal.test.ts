import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { recordExpense } from "../../src/domain/commands/recordExpense.js";
import { recordIncome } from "../../src/domain/commands/recordIncome.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { assertExactReversal, buildTransactionReversal } from "../../src/domain/corrections/reversal.js";
import { accountFixture, paiseOf, snapshotFixture } from "./fixtures.js";

const occurredOn = isoDate("2026-08-01");
const capturedAt = "2026-08-01T04:30:00.000Z";

describe("exact transaction reversal", () => {
  it("inverts an account-funded expense posting for posting", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordExpense(
      {
        occurredOn,
        capturedAt,
        accountId: account.id,
        allocations: [
          { categoryId: "cat-grocery", amountPaise: paiseOf(1_200) },
          { categoryId: "cat-household", amountPaise: paiseOf(800) },
        ],
      },
      snapshot,
    );
    const target = batch.events[0]!;
    const reversal = buildTransactionReversal(target, batch.postings, "2026-08-20T10:00:00.000Z");
    expect(reversal.event.meaning).toBe("transaction_reversal");
    expect(reversal.event.reversalOfEventId).toBe(target.id);
    expect(reversal.postings).toHaveLength(batch.postings.length);
    for (const original of batch.postings) {
      const inverse = reversal.postings.find(
        (posting) =>
          posting.accountId === original.accountId &&
          posting.categoryId === original.categoryId &&
          posting.pnl === original.pnl &&
          posting.amountPaise === paise(-original.amountPaise),
      );
      expect(inverse).toBeDefined();
    }
    assertConservation("transaction_reversal", {
      events: [target, reversal.event],
      postings: [...batch.postings, ...reversal.postings],
      openings: [],
    });
  });

  it("inverts an other-income fixture", () => {
    const account = accountFixture({ balancePaise: paiseOf(10_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordIncome(
      {
        occurredOn,
        capturedAt,
        amountPaise: paiseOf(2_500),
        accountId: account.id,
        kind: "other",
      },
      snapshot,
    );
    const target = batch.events[0]!;
    const reversal = buildTransactionReversal(target, batch.postings, "2026-08-20T10:00:00.000Z");
    expect(reversal.postings.some((posting) => posting.pnl === "income_other" && posting.amountPaise === paiseOf(-2_500))).toBe(
      true,
    );
    expect(reversal.postings.some((posting) => posting.accountId === account.id && posting.amountPaise === paiseOf(-2_500))).toBe(
      true,
    );
  });

  it("rejects an amount mismatch", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordExpense(
      {
        occurredOn,
        capturedAt,
        accountId: account.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(500) }],
      },
      snapshot,
    );
    const target = batch.events[0]!;
    const reversal = buildTransactionReversal(target, batch.postings, capturedAt);
    reversal.postings[0] = { ...reversal.postings[0]!, amountPaise: paise(1) };
    expect(() => assertExactReversal(target, batch.postings, reversal.event, reversal.postings)).toThrow(DomainError);
  });

  it("rejects a posting semantic mismatch", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordExpense(
      {
        occurredOn,
        capturedAt,
        accountId: account.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(500) }],
      },
      snapshot,
    );
    const target = batch.events[0]!;
    const reversal = buildTransactionReversal(target, batch.postings, capturedAt);
    const flipped = reversal.postings.map((posting) =>
      posting.pnl === "expense" ? { ...posting, categoryId: "cat-household" } : posting,
    );
    expect(() => assertExactReversal(target, batch.postings, reversal.event, flipped)).toThrow(DomainError);
  });

  it("does not treat a reversal as income conservation", () => {
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    const { batch } = recordExpense(
      {
        occurredOn,
        capturedAt,
        accountId: account.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(500) }],
      },
      snapshot,
    );
    const reversal = buildTransactionReversal(batch.events[0]!, batch.postings, capturedAt);
    expect(() =>
      assertConservation("income", {
        events: [reversal.event],
        postings: reversal.postings,
        openings: [],
      }),
    ).toThrow(DomainError);
  });
});
