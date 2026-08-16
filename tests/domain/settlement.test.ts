import { describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { suggestAllocations } from "../../src/domain/commands/suggestAllocations.js";
import { receiveSettlement } from "../../src/domain/commands/receiveSettlement.js";
import { paySettlement } from "../../src/domain/commands/paySettlement.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import {
  accountFixture,
  claimFixture,
  paiseOf,
  personFixture,
  snapshotFixture,
} from "./fixtures.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

describe("suggestAllocations", () => {
  it("is deterministic, oldest first, and never exceeds open amounts", () => {
    const older = claimFixture({
      id: "claim-a",
      originalAmountPaise: paiseOf(1_500),
      openAmountPaise: paiseOf(1_500),
      kind: "shared_bill",
    });
    const newer = claimFixture({
      id: "claim-b",
      originalAmountPaise: paiseOf(2_000),
      openAmountPaise: paiseOf(2_000),
      kind: "direct_loan",
    });
    const first = suggestAllocations(
      [
        { ...newer, occurredOn: isoDate("2026-08-10") },
        { ...older, occurredOn: isoDate("2026-08-01") },
      ],
      paiseOf(2_500),
    );
    const second = suggestAllocations(
      [
        { ...older, occurredOn: isoDate("2026-08-01") },
        { ...newer, occurredOn: isoDate("2026-08-10") },
      ],
      paiseOf(2_500),
    );
    expect(first).toEqual(second);
    expect(first).toEqual([
      { claimId: "claim-a", amountPaise: 150_000 },
      { claimId: "claim-b", amountPaise: 100_000 },
    ]);
    expect(first.every((item, index) => {
      const open = [older, newer][index]?.openAmountPaise ?? 0;
      return item.amountPaise <= open;
    })).toBe(true);
  });
});

describe("receiveSettlement and paySettlement", () => {
  it("receives a full receivable without income", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const rahul = personFixture({ name: "Rahul" });
    const claim = claimFixture({
      personId: rahul.id,
      originalAmountPaise: paiseOf(2_000),
      kind: "direct_loan",
    });
    const { batch, preview } = receiveSettlement(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        accountId: hdfc.id,
        personId: rahul.id,
        amountPaise: paiseOf(2_000),
        allocations: [{ claimId: claim.id, amountPaise: paiseOf(2_000) }],
      },
      snapshotFixture({ accounts: [hdfc], people: [rahul], claims: [claim] }),
    );
    expect(batch.events[0]?.meaning).toBe("settlement_in");
    expect(batch.postings.find((posting) => posting.accountId)?.amountPaise).toBe(200_000);
    expect(batch.postings.find((posting) => posting.claimId)?.amountPaise).toBe(-200_000);
    expect(batch.claimStatusUpdates?.[0]?.status).toBe("settled");
    expect(preview.classifications.income).toBe(0);
    expect(batch.settlementAllocations?.[0]?.createsReservation).toBe(false);
  });

  it("pays a payable without expense", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const rahul = personFixture({ name: "Rahul" });
    const claim = claimFixture({
      personId: rahul.id,
      direction: "user_owes_them",
      kind: "borrowing",
      originalAmountPaise: paiseOf(2_000),
    });
    const { batch, preview } = paySettlement(
      {
        occurredOn: isoDate("2026-08-16"),
        capturedAt,
        accountId: hdfc.id,
        personId: rahul.id,
        amountPaise: paiseOf(2_000),
        allocations: [{ claimId: claim.id, amountPaise: paiseOf(2_000) }],
      },
      snapshotFixture({ accounts: [hdfc], people: [rahul], claims: [claim] }),
    );
    expect(batch.events[0]?.meaning).toBe("settlement_out");
    expect(batch.postings.find((posting) => posting.accountId)?.amountPaise).toBe(-200_000);
    expect(preview.classifications.spent).toBe(0);
  });

  it("rejects over-allocation, under-allocation, wrong person, wrong direction, and duplicates", () => {
    const hdfc = accountFixture({ balancePaise: paiseOf(50_000) });
    const rahul = personFixture({ name: "Rahul" });
    const amit = personFixture({ name: "Amit" });
    const receivable = claimFixture({
      personId: rahul.id,
      originalAmountPaise: paiseOf(1_000),
    });
    const payable = claimFixture({
      personId: rahul.id,
      direction: "user_owes_them",
      kind: "borrowing",
      originalAmountPaise: paiseOf(1_000),
    });
    const amitClaim = claimFixture({
      personId: amit.id,
      originalAmountPaise: paiseOf(1_000),
    });
    const snapshot = snapshotFixture({
      accounts: [hdfc],
      people: [rahul, amit],
      claims: [receivable, payable, amitClaim],
    });
    const base = {
      occurredOn: isoDate("2026-08-16"),
      capturedAt,
      accountId: hdfc.id,
      personId: rahul.id,
    };
    expect(() =>
      receiveSettlement(
        { ...base, amountPaise: paiseOf(1_000), allocations: [{ claimId: receivable.id, amountPaise: paiseOf(1_200) }] },
        snapshot,
      ),
    ).toThrow(DomainError);
    expect(() =>
      receiveSettlement(
        { ...base, amountPaise: paiseOf(2_000), allocations: [{ claimId: receivable.id, amountPaise: paiseOf(1_000) }] },
        snapshot,
      ),
    ).not.toThrow();
    expect(() =>
      receiveSettlement(
        { ...base, amountPaise: paiseOf(1_000), allocations: [{ claimId: payable.id, amountPaise: paiseOf(1_000) }] },
        snapshot,
      ),
    ).toThrow(/wrong claim direction/);
    expect(() =>
      receiveSettlement(
        { ...base, amountPaise: paiseOf(1_000), allocations: [{ claimId: amitClaim.id, amountPaise: paiseOf(1_000) }] },
        snapshot,
      ),
    ).toThrow(/different person/);
    expect(() =>
      receiveSettlement(
        {
          ...base,
          amountPaise: paiseOf(1_000),
          allocations: [
            { claimId: receivable.id, amountPaise: paiseOf(500) },
            { claimId: receivable.id, amountPaise: paiseOf(500) },
          ],
        },
        snapshot,
      ),
    ).toThrow(/allocated twice/);
  });
});
