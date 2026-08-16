import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { recordSplit } from "../../src/domain/commands/recordSplit.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import {
  accountFixture,
  cardFixture,
  ICICI_RULE,
  paiseOf,
  personFixture,
  snapshotFixture,
} from "./fixtures.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

describe("recordSplit", () => {
  it("splits a bank purchase into personal expense and claims", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const rahul = personFixture({ name: "Rahul" });
    const { batch, preview } = recordSplit(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        amountPaise: paiseOf(3_000),
        source: { type: "account", accountId: hdfc.id },
        userSharePaise: paiseOf(1_200),
        personShares: [{ personId: rahul.id, amountPaise: paiseOf(1_800) }],
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(1_200) }],
        merchant: "Restaurant",
      },
      snapshotFixture({ accounts: [hdfc], people: [rahul] }),
    );

    expect(batch.events[0]?.meaning).toBe("split");
    expect(batch.postings.find((posting) => posting.accountId)?.amountPaise).toBe(-300_000);
    expect(batch.postings.find((posting) => posting.pnl === "expense")?.amountPaise).toBe(120_000);
    expect(batch.claims).toHaveLength(1);
    expect(batch.claims?.[0]?.kind).toBe("shared_bill");
    expect(batch.claims?.[0]?.originalAmountPaise).toBe(180_000);
    const shareTotal = (batch.eventShares ?? []).reduce((sum, share) => sum + share.amountPaise, 0);
    expect(shareTotal).toBe(300_000);
    expect(preview.classifications.spent).toBe(120_000);
    expect(() => assertConservation("split", batch)).not.toThrow();
  });

  it("splits a card purchase and links claims to the cycle", () => {
    const card = cardFixture();
    const rahul = personFixture({ name: "Rahul" });
    const { batch } = recordSplit(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        amountPaise: paiseOf(4_000),
        source: { type: "card", creditCardId: card.id, rule: ICICI_RULE },
        userSharePaise: paiseOf(1_500),
        personShares: [{ personId: rahul.id, amountPaise: paiseOf(2_500) }],
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(1_500) }],
      },
      snapshotFixture({ creditCards: [card], people: [rahul] }),
    );
    expect(batch.postings.find((posting) => posting.creditCardId)?.amountPaise).toBe(400_000);
    expect(batch.claims?.[0]?.kind).toBe("card_share");
    expect(batch.claims?.[0]?.billingCycleId).toBe(batch.events[0]?.billingCycleId);
    expect(batch.claims?.[0]?.originalAmountPaise).toBe(250_000);
  });

  it("rejects shares that do not sum to the event total", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const rahul = personFixture();
    expect(() =>
      recordSplit(
        {
          occurredOn: isoDate("2026-08-16"),
          capturedAt,
          amountPaise: paiseOf(3_000),
          source: { type: "account", accountId: hdfc.id },
          userSharePaise: paiseOf(1_200),
          personShares: [{ personId: rahul.id, amountPaise: paiseOf(1_000) }],
          allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(1_200) }],
        },
        snapshotFixture({ accounts: [hdfc], people: [rahul] }),
      ),
    ).toThrow(DomainError);
  });
});
