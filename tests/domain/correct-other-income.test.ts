import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { newId } from "../../src/domain/ids.js";
import { recordIncome } from "../../src/domain/commands/recordIncome.js";
import { recordExpense } from "../../src/domain/commands/recordExpense.js";
import { correctOtherIncome } from "../../src/domain/commands/correctOtherIncome.js";
import { assertEligibleOtherIncomeCorrection } from "../../src/domain/corrections/eligibility.js";
import { canonicalizeOtherIncomeCorrectionPayload } from "../../src/domain/corrections/payload.js";
import { assertConservation } from "../../src/domain/conservation/validate.js";
import { assertExactReversal } from "../../src/domain/corrections/reversal.js";
import { applyBatchOverlay } from "../../src/domain/engine/overlay.js";
import { accountAvailability } from "../../src/domain/engine/liquidity.js";
import { accountFixture, paiseOf, reservationFixture, snapshotFixture } from "./fixtures.js";
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
    categories: [{ id: "cat-eating", parentId: null, name: "Eating Out", archivedAt: null }],
  });
}

function receive(
  snapshot: ReturnType<typeof snapshotWithAccounts>,
  args: { accountId: string; amountPaise: number; notes?: string | null; kind?: "other" | "salary" },
) {
  const recorded = recordIncome(
    {
      occurredOn,
      capturedAt: "2026-08-01T04:30:00.000Z",
      amountPaise: paise(args.amountPaise),
      accountId: args.accountId,
      kind: args.kind ?? "other",
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
  prepared: ReturnType<typeof correctOtherIncome>,
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

function correct(
  snapshot: ReturnType<typeof snapshotWithAccounts>,
  targetEventId: string,
  extras: {
    commandId?: string;
    rootEventId?: string;
    amountPaise: number;
    destinationAccountId?: string;
    notes?: string | null;
    reason?: string | null;
    occurredOn?: string;
  },
) {
  return correctOtherIncome(
    {
      commandId: extras.commandId ?? "c1",
      rootEventId: extras.rootEventId ?? targetEventId,
      targetEventId,
      amountPaise: extras.amountPaise,
      destinationAccountId: extras.destinationAccountId ?? "acc-hdfc",
      occurredOn: extras.occurredOn ?? occurredOn,
      notes: extras.notes,
      reason: extras.reason,
      capturedAt,
    },
    snapshot,
  );
}

describe("correctOtherIncome domain", () => {
  it("accepts a positive other-income candidate and rejects salary", () => {
    const original = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    expect(() => assertEligibleOtherIncomeCorrection(original.event, original.snapshot)).not.toThrow();
    const salary = receive(snapshotWithAccounts(), {
      accountId: "acc-hdfc",
      amountPaise: 8_000_00,
      kind: "salary",
    });
    expect(() => assertEligibleOtherIncomeCorrection(salary.event, salary.snapshot)).toThrow(DomainError);
    try {
      assertEligibleOtherIncomeCorrection(salary.event, salary.snapshot);
    } catch (error) {
      expect((error as DomainError).code).toBe("transaction_not_correctable");
    }
  });

  it("decreases 5000 → 4500 without treating the delta as expense", () => {
    const original = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    const prepared = correct(original.snapshot, original.event.id, { amountPaise: 4_500_00 });
    expect(prepared.replacementEvent.amountPaise).toBe(4_500_00);
    expect(prepared.replacementEvent.meaning).toBe("income");
    expect(prepared.replacementPostings.some((posting) => posting.pnl === "income_other")).toBe(true);
    expect(prepared.replacementPostings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect(prepared.preview.impact.find((line) => line.label === "HDFC")?.deltaPaise).toBe(-500_00);
    expect(prepared.preview.impact.find((line) => line.kind === "income")?.deltaPaise).toBe(-500_00);
    expect(prepared.preview.impact.some((line) => line.kind === "expense")).toBe(false);
  });

  it("increases 5000 → 5500", () => {
    const original = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    const prepared = correct(original.snapshot, original.event.id, { amountPaise: 5_500_00 });
    expect(prepared.replacementEvent.amountPaise).toBe(5_500_00);
    expect(prepared.preview.impact.find((line) => line.label === "HDFC")?.deltaPaise).toBe(500_00);
    expect(prepared.preview.impact.find((line) => line.kind === "income")?.deltaPaise).toBe(500_00);
  });

  it("moves destination HDFC → PNB without changing other-income total", () => {
    const original = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    const prepared = correct(original.snapshot, original.event.id, {
      amountPaise: 5_000_00,
      destinationAccountId: "acc-pnb",
    });
    expect(prepared.replacementEvent.accountId).toBe("acc-pnb");
    expect(prepared.preview.impact.find((line) => line.label === "HDFC")?.deltaPaise).toBe(-5_000_00);
    expect(prepared.preview.impact.find((line) => line.label === "PNB")?.deltaPaise).toBe(5_000_00);
    expect(prepared.preview.impact.some((line) => line.kind === "income")).toBe(false);
  });

  it("freezes the date", () => {
    const original = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    try {
      correct(original.snapshot, original.event.id, { amountPaise: 4_500_00, occurredOn: "2026-08-02" });
      throw new Error("expected date freeze");
    } catch (error) {
      expect((error as DomainError).code).toBe("invalid_correction_date");
    }
  });

  it("uses exact reversal of the original income postings", () => {
    const original = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    const prepared = correct(original.snapshot, original.event.id, { amountPaise: 4_500_00 });
    assertExactReversal(original.event, original.postings, prepared.reversalEvent, prepared.reversalPostings);
    expect(prepared.reversalEvent.meaning).toBe("transaction_reversal");
    expect(prepared.reversalEvent.occurredOn).toBe(original.event.occurredOn);
    expect(prepared.replacementEvent.occurredOn).toBe(original.event.occurredOn);
    assertConservation("income", {
      events: [prepared.replacementEvent],
      postings: prepared.replacementPostings,
      openings: [],
    });
  });

  it("rejects a decrease that would make the account balance negative", () => {
    const received = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    const spent = recordExpense(
      {
        occurredOn,
        capturedAt,
        accountId: "acc-hdfc",
        allocations: [{ categoryId: "cat-eating", amountPaise: paise(14_800_00) }],
      },
      received.snapshot,
    );
    const afterSpend = applyBatchOverlay(received.snapshot, spent.batch, occurredOn);
    try {
      correct(afterSpend, received.event.id, { amountPaise: 4_000_00 });
      throw new Error("expected spent-income rejection");
    } catch (error) {
      expect((error as DomainError).code).toBe("insufficient_available");
    }
  });

  it("rejects a decrease that would consume reserved money", () => {
    const base = snapshotWithAccounts();
    const reserved = snapshotFixture({
      ...base,
      reservations: [
        reservationFixture({
          sourceAccountId: "acc-hdfc",
          amountOriginalPaise: paise(14_600_00),
          remainingPaise: paise(14_600_00),
        }),
      ],
    });
    const received = receive(reserved, { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    try {
      correct(received.snapshot, received.event.id, { amountPaise: 4_000_00 });
      throw new Error("expected reserved-money rejection");
    } catch (error) {
      expect((error as DomainError).code).toBe("correction_would_use_reserved_money");
    }
  });

  it("rejects a decrease that would make pending-surplus available cash negative", () => {
    const base = snapshotWithAccounts();
    const pending = snapshotFixture({
      ...base,
      surplusCases: [
        {
          id: "surplus-1",
          amountPaise: paise(14_600_00),
          kind: "unallocated_settlement",
          sourceAccountId: "acc-hdfc",
          personId: null,
          reservationId: null,
          eventId: null,
          explanation: "Pending",
          status: "pending",
          resolution: null,
          resolvedAt: null,
          resolvedByEventId: null,
        },
      ],
    });
    const received = receive(pending, { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    expect(accountAvailability(received.snapshot, "acc-hdfc").availablePaise).toBe(400_00);
    try {
      correct(received.snapshot, received.event.id, { amountPaise: 4_000_00 });
      throw new Error("expected pending-surplus rejection");
    } catch (error) {
      expect((error as DomainError).code).toBe("correction_would_use_reserved_money");
    }
  });

  it("rejects a destination change when the original account cannot surrender the credit", () => {
    const received = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    const spent = recordExpense(
      {
        occurredOn,
        capturedAt,
        accountId: "acc-hdfc",
        allocations: [{ categoryId: "cat-eating", amountPaise: paise(12_000_00) }],
      },
      received.snapshot,
    );
    const afterSpend = applyBatchOverlay(received.snapshot, spent.batch, occurredOn);
    try {
      correct(afterSpend, received.event.id, { amountPaise: 5_000_00, destinationAccountId: "acc-pnb" });
      throw new Error("expected destination-change rejection");
    } catch (error) {
      expect((error as DomainError).code).toBe("insufficient_available");
    }
  });

  it("normalizes notes and keeps reason out of economics", () => {
    const original = receive(snapshotWithAccounts(), {
      accountId: "acc-hdfc",
      amountPaise: 5_000_00,
      notes: "Freelance payment",
    });
    const prepared = correct(original.snapshot, original.event.id, {
      amountPaise: 5_000_00,
      notes: "  Client refund  ",
      reason: "  Wrong amount  ",
    });
    expect(original.event.notes).toBe("Freelance payment");
    expect(prepared.replacementEvent.notes).toBe("Client refund");
    expect(prepared.material.reason).toBe("Wrong amount");
    expect(
      canonicalizeOtherIncomeCorrectionPayload({
        family: "other_income",
        rootEventId: original.event.id,
        targetEventId: original.event.id,
        amountPaise: 5_000_00,
        sourceAccountId: "acc-hdfc",
        occurredOn,
        notes: "   ",
        reason: undefined,
      }).notes,
    ).toBeNull();
  });

  it("builds a second sequential correction against the first replacement", () => {
    const original = receive(snapshotWithAccounts(), { accountId: "acc-hdfc", amountPaise: 5_000_00 });
    const first = correct(original.snapshot, original.event.id, { amountPaise: 4_500_00, commandId: "first" });
    const afterFirst = overlayCorrection(original.snapshot, first, "first");
    const second = correct(afterFirst, first.replacementEvent.id, {
      amountPaise: 4_500_00,
      destinationAccountId: "acc-pnb",
      rootEventId: first.rootEventId,
      commandId: "second",
      reason: "Wrong account",
    });
    expect(second.rootEventId).toBe(original.event.id);
    expect(second.replacementEvent.accountId).toBe("acc-pnb");
    try {
      correct(afterFirst, original.event.id, {
        amountPaise: 4_000_00,
        rootEventId: first.rootEventId,
      });
      throw new Error("expected stale original");
    } catch (error) {
      expect((error as DomainError).code).toBe("stale_correction_target");
    }
  });
});
