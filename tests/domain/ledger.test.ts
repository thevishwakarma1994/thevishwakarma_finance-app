import { describe, expect, it } from "vitest";
import { newId } from "../../src/domain/ids.js";
import { EVENT_MEANINGS } from "../../src/domain/ledger/types.js";
import { recordIncome } from "../../src/domain/commands/recordIncome.js";
import { applyOpening } from "../../src/domain/commands/applyOpening.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { accountFixture, paiseOf, snapshotFixture } from "./fixtures.js";

describe("ledger primitives", () => {
  it("generates UUIDv7 ids", () => {
    const id = newId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("keeps FinancialEvent meanings and snapshots free of workspace identity", () => {
    expect(EVENT_MEANINGS).toContain("income");
    expect(EVENT_MEANINGS).toContain("spend_account");
    expect(EVENT_MEANINGS).toContain("spend_card");
    expect(EVENT_MEANINGS).toContain("pay_obligation");
    const account = accountFixture({ balancePaise: paiseOf(50_000) });
    const snapshot = snapshotFixture({ accounts: [account] });
    expect(snapshot).not.toHaveProperty("workspaceId");
    const { batch, preview } = recordIncome(
      {
        occurredOn: isoDate("2026-08-05"),
        capturedAt: "2026-08-05T04:30:00.000Z",
        amountPaise: paiseOf(79_200),
        accountId: account.id,
        kind: "salary",
      },
      snapshot,
    );
    expect(batch.events[0]?.meaning).toBe("income");
    expect(batch).not.toHaveProperty("workspaceId");
    expect(preview.effects[0]?.kind).toBe("account");
  });

  it("treats opening as starting state, not an income event", () => {
    const account = accountFixture();
    const snapshot = snapshotFixture({ accounts: [account], openings: [] });
    const { batch, preview } = applyOpening(
      {
        accountId: account.id,
        effectiveOn: isoDate("2026-08-01"),
        balancePaise: paiseOf(50_000),
      },
      snapshot,
    );
    expect(batch.events).toHaveLength(0);
    expect(batch.postings).toHaveLength(0);
    expect(batch.openings).toHaveLength(1);
    expect(preview.classifications.income).toBe(0);
  });
});
