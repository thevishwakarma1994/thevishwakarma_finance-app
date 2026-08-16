import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { recordCardSpend } from "../../src/domain/commands/recordCardSpend.js";
import {
  cardFixture,
  ICICI_RULE,
  paiseOf,
  personFixture,
  snapshotFixture,
} from "./fixtures.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

describe("card default owner", () => {
  it("treats an omitted owner as the card default person", () => {
    const rahul = personFixture({ name: "Rahul" });
    const card = cardFixture({ defaultOwnerPersonId: rahul.id });
    const { batch, preview } = recordCardSpend(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        creditCardId: card.id,
        allocations: [],
        amountPaise: paiseOf(5_000),
        rule: ICICI_RULE,
      },
      snapshotFixture({ creditCards: [card], people: [rahul] }),
    );
    expect(batch.postings.find((posting) => posting.creditCardId)?.amountPaise).toBe(500_000);
    expect(batch.postings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect(batch.claims?.[0]?.originalAmountPaise).toBe(500_000);
    expect(batch.claims?.[0]?.kind).toBe("card_share");
    expect(preview.classifications.spent).toBe(0);
    expect(preview.warnings[0]).toMatch(/Rahul's by default/);
  });

  it("keeps a personal override as the user's expense", () => {
    const rahul = personFixture({ name: "Rahul" });
    const card = cardFixture({ defaultOwnerPersonId: rahul.id });
    const { batch } = recordCardSpend(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        creditCardId: card.id,
        allocations: [{ categoryId: "cat-grocery", amountPaise: paiseOf(5_000) }],
        ownerPersonId: null,
        rule: ICICI_RULE,
      },
      snapshotFixture({ creditCards: [card], people: [rahul] }),
    );
    expect(batch.postings.find((posting) => posting.pnl === "expense")?.amountPaise).toBe(500_000);
    expect(batch.claims ?? []).toHaveLength(0);
    expect(batch.eventShares?.every((share) => share.isUser)).toBe(true);
  });
});
