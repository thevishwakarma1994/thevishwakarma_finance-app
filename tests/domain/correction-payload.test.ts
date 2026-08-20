import { describe, expect, it } from "vitest";
import {
  canonicalizeExpenseCorrectionPayload,
  canonicalizeOtherIncomeCorrectionPayload,
  correctionPayloadsEqual,
  newCorrectionArtifactIds,
} from "../../src/domain/corrections/payload.js";

describe("canonical 16C1 correction payload", () => {
  it("sorts allocations and normalizes blank text and reason whitespace", () => {
    const canonical = canonicalizeExpenseCorrectionPayload({
      family: "expense",
      rootEventId: "root",
      targetEventId: "root",
      amountPaise: 1_580_00,
      sourceAccountId: "acc",
      occurredOn: "2026-08-01",
      allocations: [
        { categoryId: "b", amountPaise: 80_00 },
        { categoryId: "a", amountPaise: 1_500_00 },
      ],
      merchant: "  ",
      notes: undefined,
      reason: "  typo  ",
    });
    expect(canonical.allocations.map((item) => item.categoryId)).toEqual(["a", "b"]);
    expect(canonical.merchant).toBeNull();
    expect(canonical.notes).toBeNull();
    expect(canonical.reason).toBe("typo");
    expect(canonical.occurredOn).toBe("2026-08-01");
  });

  it("treats equivalent payloads as equal even when allocation order differs", () => {
    expect(
      correctionPayloadsEqual(
        {
          family: "expense",
          rootEventId: "root",
          targetEventId: "leaf",
          amountPaise: 200,
          sourceAccountId: "acc",
          occurredOn: "2026-08-01",
          allocations: [
            { categoryId: "z", amountPaise: 50 },
            { categoryId: "a", amountPaise: 150 },
          ],
          merchant: null,
          notes: "",
          reason: "fix",
        },
        {
          family: "expense",
          rootEventId: "root",
          targetEventId: "leaf",
          amountPaise: 200,
          sourceAccountId: "acc",
          occurredOn: "2026-08-01",
          allocations: [
            { categoryId: "a", amountPaise: 150 },
            { categoryId: "z", amountPaise: 50 },
          ],
          merchant: undefined,
          notes: null,
          reason: " fix ",
        },
      ),
    ).toBe(true);
  });

  it("keeps other-income payload identity separate from expense", () => {
    const income = canonicalizeOtherIncomeCorrectionPayload({
      family: "other_income",
      rootEventId: "root",
      targetEventId: "root",
      amountPaise: 5_500_00,
      sourceAccountId: "acc",
      occurredOn: "2026-08-01",
      notes: "bonus",
      reason: null,
    });
    expect(income.family).toBe("other_income");
    expect(
      correctionPayloadsEqual(income, {
        family: "expense",
        rootEventId: "root",
        targetEventId: "root",
        amountPaise: 5_500_00,
        sourceAccountId: "acc",
        occurredOn: "2026-08-01",
        allocations: [],
        merchant: null,
        notes: "bonus",
        reason: null,
      }),
    ).toBe(false);
  });

  it("normalizes blank other-income notes and reason", () => {
    const income = canonicalizeOtherIncomeCorrectionPayload({
      family: "other_income",
      rootEventId: "root",
      targetEventId: "root",
      amountPaise: 5_000_00,
      sourceAccountId: "acc",
      occurredOn: "2026-08-01",
      notes: "   ",
      reason: undefined,
    });
    expect(income.notes).toBeNull();
    expect(income.reason).toBeNull();
  });

  it("does not derive reversal/replacement ids from the command id", () => {
    const first = newCorrectionArtifactIds();
    const second = newCorrectionArtifactIds();
    expect(first.reversalEventId).not.toBe(first.replacementEventId);
    expect(first.reversalEventId).not.toBe(second.reversalEventId);
  });
});
