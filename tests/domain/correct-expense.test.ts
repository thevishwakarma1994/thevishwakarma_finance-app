import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { newId } from "../../src/domain/ids.js";
import { recordExpense } from "../../src/domain/commands/recordExpense.js";
import { correctExpense } from "../../src/domain/commands/correctExpense.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { assertExactReversal } from "../../src/domain/corrections/reversal.js";
import { applyBatchOverlay } from "../../src/domain/engine/overlay.js";
import { accountFixture, paiseOf, snapshotFixture } from "./fixtures.js";
import type { TransactionCorrectionRecord } from "../../src/domain/corrections/types.js";

const occurredOn = isoDate("2026-08-01");
const capturedAt = "2026-08-20T10:00:00.000Z";

function snapshotWithAccounts() {
  const hdfc = accountFixture({ id: "acc-hdfc", displayName: "HDFC", balancePaise: paiseOf(10_000) });
  const pnb = accountFixture({
    id: "acc-pnb",
    displayName: "PNB",
    isPrimarySalary: false,
    balancePaise: paiseOf(5_000),
  });
  return snapshotFixture({
    accounts: [hdfc, pnb],
    categories: [
      { id: "cat-eating", parentId: null, name: "Eating Out", archivedAt: null },
      { id: "cat-grocery", parentId: null, name: "Grocery", archivedAt: null },
      { id: "cat-household", parentId: null, name: "Household", archivedAt: null },
    ],
  });
}

function spend(
  snapshot: ReturnType<typeof snapshotWithAccounts>,
  args: {
    accountId: string;
    allocations: { categoryId: string; amountPaise: number }[];
    merchant?: string | null;
    notes?: string | null;
  },
) {
  const recorded = recordExpense(
    {
      occurredOn,
      capturedAt: "2026-08-01T04:30:00.000Z",
      accountId: args.accountId,
      allocations: args.allocations.map((item) => ({
        categoryId: item.categoryId,
        amountPaise: paise(item.amountPaise),
      })),
      merchant: args.merchant,
      notes: args.notes,
    },
    snapshot,
  );
  return {
    event: recorded.batch.events[0]!,
    postings: recorded.batch.postings,
    snapshot: applyBatchOverlay(snapshot, recorded.batch, occurredOn),
  };
}

function overlayCorrection(
  snapshot: ReturnType<typeof snapshotWithAccounts>,
  prepared: ReturnType<typeof correctExpense>,
  commandId = "cmd-1",
) {
  const correction: TransactionCorrectionRecord = {
    id: newId(),
    workspaceId: "ws",
    commandId,
    rootEventId: prepared.rootEventId,
    targetEventId: prepared.targetEventId,
    reversalEventId: prepared.reversalEvent.id,
    replacementEventId: prepared.replacementEvent.id,
    correctedOn: occurredOn,
    capturedAt,
    reason: prepared.material.reason ?? null,
  };
  return applyBatchOverlay(
    snapshot,
    {
      events: [prepared.reversalEvent, prepared.replacementEvent],
      postings: [...prepared.reversalPostings, ...prepared.replacementPostings],
      openings: [],
      transactionCorrections: [correction],
    },
    occurredOn,
  );
}

describe("correctExpense domain", () => {
  it("A — amount decrease 1850 → 1580", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 1_850_00 }],
    });
    const prepared = correctExpense(
      {
        commandId: "a",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 1_580_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 1_580_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    expect(prepared.replacementEvent.amountPaise).toBe(1_580_00);
    expect(prepared.preview.impact.find((line) => line.kind === "account")?.deltaPaise).toBe(270_00);
    expect(prepared.preview.impact.find((line) => line.kind === "expense")?.deltaPaise).toBe(-270_00);
  });

  it("B — amount increase 1580 → 1850", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 1_580_00 }],
    });
    const prepared = correctExpense(
      {
        commandId: "b",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 1_850_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 1_850_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    expect(prepared.replacementEvent.amountPaise).toBe(1_850_00);
    expect(prepared.preview.impact.find((line) => line.kind === "account")?.deltaPaise).toBe(-270_00);
  });

  it("C — source HDFC → PNB", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-grocery", amountPaise: 2_000_00 }],
    });
    const prepared = correctExpense(
      {
        commandId: "c",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 2_000_00,
        sourceAccountId: "acc-pnb",
        occurredOn,
        allocations: [{ categoryId: "cat-grocery", amountPaise: 2_000_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    expect(prepared.replacementEvent.accountId).toBe("acc-pnb");
    expect(prepared.preview.impact.find((line) => line.label === "HDFC")?.deltaPaise).toBe(2_000_00);
    expect(prepared.preview.impact.find((line) => line.label === "PNB")?.deltaPaise).toBe(-2_000_00);
    expect(prepared.preview.impact.some((line) => line.kind === "expense")).toBe(false);
  });

  it("D — category Eating Out → Grocery", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 2_000_00 }],
    });
    const prepared = correctExpense(
      {
        commandId: "d",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 2_000_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-grocery", amountPaise: 2_000_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    expect(prepared.preview.impact.find((line) => line.label === "Eating Out")?.deltaPaise).toBe(-2_000_00);
    expect(prepared.preview.impact.find((line) => line.label === "Grocery")?.deltaPaise).toBe(2_000_00);
    expect(prepared.preview.impact.some((line) => line.kind === "account")).toBe(false);
  });

  it("E — multi-category correction", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 2_000_00 }],
    });
    const prepared = correctExpense(
      {
        commandId: "e",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 2_000_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [
          { categoryId: "cat-grocery", amountPaise: 1_200_00 },
          { categoryId: "cat-household", amountPaise: 800_00 },
        ],
        capturedAt,
      },
      original.snapshot,
    );
    expect(prepared.replacementEvent.categoryId).toBeNull();
    expect(prepared.replacementPostings.filter((posting) => posting.pnl === "expense")).toHaveLength(2);
  });

  it("F — merchant change lives on the replacement", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 500_00 }],
      merchant: "Cafe",
    });
    const prepared = correctExpense(
      {
        commandId: "f",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 500_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 500_00 }],
        merchant: "Bakery",
        capturedAt,
      },
      original.snapshot,
    );
    expect(original.event.merchant).toBe("Cafe");
    expect(prepared.replacementEvent.merchant).toBe("Bakery");
    expect(prepared.preview.original.merchant).toBe("Cafe");
    expect(prepared.preview.corrected.merchant).toBe("Bakery");
  });

  it("G — notes change lives on the replacement and blanks normalize", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 500_00 }],
      notes: "typo",
    });
    const prepared = correctExpense(
      {
        commandId: "g",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 500_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 500_00 }],
        notes: "   ",
        capturedAt,
      },
      original.snapshot,
    );
    expect(original.event.notes).toBe("typo");
    expect(prepared.replacementEvent.notes).toBeNull();
  });

  it("H — date change is rejected", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 500_00 }],
    });
    expect(() =>
      correctExpense(
        {
          commandId: "h",
          rootEventId: original.event.id,
          targetEventId: original.event.id,
          amountPaise: 500_00,
          sourceAccountId: "acc-hdfc",
          occurredOn: "2026-08-02",
          allocations: [{ categoryId: "cat-eating", amountPaise: 500_00 }],
          capturedAt,
        },
        original.snapshot,
      ),
    ).toThrow(DomainError);
    try {
      correctExpense(
        {
          commandId: "h",
          rootEventId: original.event.id,
          targetEventId: original.event.id,
          amountPaise: 500_00,
          sourceAccountId: "acc-hdfc",
          occurredOn: "2026-08-02",
          allocations: [{ categoryId: "cat-eating", amountPaise: 500_00 }],
          capturedAt,
        },
        original.snapshot,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("invalid_correction_date");
    }
  });

  it("I — exact reversal conservation", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 1_850_00 }],
    });
    const prepared = correctExpense(
      {
        commandId: "i",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 1_580_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 1_580_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    assertExactReversal(original.event, original.postings, prepared.reversalEvent, prepared.reversalPostings);
    const combined =
      original.postings.reduce((sum, posting) => sum + posting.amountPaise, 0) +
      prepared.reversalPostings.reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(combined).toBe(0);
  });

  it("J — replacement conservation", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 1_850_00 }],
    });
    const prepared = correctExpense(
      {
        commandId: "j",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 1_580_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 1_580_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    assertConservation("spend_account", {
      events: [prepared.replacementEvent],
      postings: prepared.replacementPostings,
      openings: [],
    });
    expect(prepared.replacementEvent.meaning).toBe("spend_account");
    expect(prepared.replacementEvent.occurredOn).toBe(occurredOn);
  });

  it("K — stale target is rejected", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 1_850_00 }],
    });
    const first = correctExpense(
      {
        commandId: "k1",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 1_580_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 1_580_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    const after = overlayCorrection(original.snapshot, first);
    expect(() =>
      correctExpense(
        {
          commandId: "k2",
          rootEventId: original.event.id,
          targetEventId: original.event.id,
          amountPaise: 1_620_00,
          sourceAccountId: "acc-hdfc",
          occurredOn,
          allocations: [{ categoryId: "cat-eating", amountPaise: 1_620_00 }],
          capturedAt,
        },
        after,
      ),
    ).toThrow(/already corrected/);
    try {
      correctExpense(
        {
          commandId: "k2",
          rootEventId: original.event.id,
          targetEventId: original.event.id,
          amountPaise: 1_620_00,
          sourceAccountId: "acc-hdfc",
          occurredOn,
          allocations: [{ categoryId: "cat-eating", amountPaise: 1_620_00 }],
          capturedAt,
        },
        after,
      );
    } catch (error) {
      expect((error as DomainError).code).toBe("stale_correction_target");
    }
  });

  it("L — second sequential correction uses the previous replacement", () => {
    const base = snapshotWithAccounts();
    const original = spend(base, {
      accountId: "acc-hdfc",
      allocations: [{ categoryId: "cat-eating", amountPaise: 1_850_00 }],
    });
    const first = correctExpense(
      {
        commandId: "l1",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 1_580_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 1_580_00 }],
        capturedAt,
      },
      original.snapshot,
    );
    const after = overlayCorrection(original.snapshot, first);
    const second = correctExpense(
      {
        commandId: "l2",
        rootEventId: original.event.id,
        targetEventId: first.replacementEvent.id,
        amountPaise: 1_620_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        allocations: [{ categoryId: "cat-eating", amountPaise: 1_620_00 }],
        capturedAt,
      },
      after,
    );
    expect(second.targetEventId).toBe(first.replacementEvent.id);
    expect(second.replacementEvent.amountPaise).toBe(1_620_00);
    expect(second.rootEventId).toBe(original.event.id);
  });
});
