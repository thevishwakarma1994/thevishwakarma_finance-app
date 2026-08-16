import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { personPosition } from "../../src/domain/people/position.js";
import { suggestAllocations, suggestableClaimsFor } from "../../src/domain/commands/suggestAllocations.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { listActivity, monthReview, personDetail } from "../../src/db/reads.js";
import { claims, financialEvents, postings, settlementAllocations } from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { createCard } from "../../src/app/cards.js";
import { createPerson } from "../../src/app/people.js";
import { lendMoney } from "../../src/app/lendMoney.js";
import { borrowMoney } from "../../src/app/borrowMoney.js";
import { recordSplit } from "../../src/app/recordSplit.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";
import { paySettlement } from "../../src/app/paySettlement.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

function setup() {
  const handles = openMemoryDatabase();
  applyMigrations(handles);
  const workspaceId = getSoleWorkspaceId(handles);
  const snapshot = loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  if (!hdfc || !grocery) throw new Error("Expected seeded HDFC and Grocery");
  applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 5_000_000,
    commit: true,
  });
  const card = createCard(handles, { workspaceId }, {
    displayName: "ICICI",
    issuer: "ICICI",
    mask: "8001",
    statementDay: 12,
    dueDaysAfterStatement: 18,
    defaultPaymentAccountId: hdfc.id,
  });
  const rahul = createPerson(handles, { workspaceId }, { name: "Rahul" });
  const amit = createPerson(handles, { workspaceId }, { name: "Amit" });
  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    groceryId: grocery.id,
    cardId: card.id,
    rahulId: rahul.id,
    amitId: amit.id,
  };
}

function tableCounts(handles: SqliteHandles, workspaceId: string) {
  return {
    events:
      handles.db
        .select({ value: count() })
        .from(financialEvents)
        .where(eq(financialEvents.workspaceId, workspaceId))
        .get()?.value ?? 0,
    postings:
      handles.db
        .select({ value: count() })
        .from(postings)
        .where(eq(postings.workspaceId, workspaceId))
        .get()?.value ?? 0,
    allocations:
      handles.db
        .select({ value: count() })
        .from(settlementAllocations)
        .where(eq(settlementAllocations.workspaceId, workspaceId))
        .get()?.value ?? 0,
    openClaims:
      handles.db
        .select({ value: count() })
        .from(claims)
        .where(eq(claims.status, "open"))
        .get()?.value ?? 0,
  };
}

function balance(handles: SqliteHandles, workspaceId: string, accountId: string): number {
  const account = loadSnapshot(handles, workspaceId).accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Account missing");
  return account.balancePaise;
}

function lend(ctx: ReturnType<typeof setup>, personId: string, amountPaise: number) {
  return lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
    occurredOn: "2026-08-16",
    capturedAt,
    accountId: ctx.hdfcId,
    personId,
    amountPaise,
    commit: true,
  });
}

describe("stage 10 settlements and claim allocation", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("A — full receivable settlement", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 200_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 200_000,
      allocations: [{ claimId: claim.id, amountPaise: 200_000 }],
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(5_000_000);
    expect(snapshot.claims[0]?.openAmountPaise).toBe(0);
    expect(snapshot.claims[0]?.status).toBe("settled");
    expect(snapshot.claims[0]?.originalAmountPaise).toBe(200_000);
    expect(snapshot.postings.some((posting) => posting.pnl)).toBe(false);
  });

  it("B — partial receivable", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 300_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 120_000,
      allocations: [{ claimId: claim.id, amountPaise: 120_000 }],
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(4_820_000);
    expect(snapshot.claims[0]?.openAmountPaise).toBe(180_000);
    expect(snapshot.claims[0]?.status).toBe("open");
  });

  it("C — full payable settlement", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    borrowMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 200_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    paySettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 200_000,
      allocations: [{ claimId: claim.id, amountPaise: 200_000 }],
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(5_000_000);
    expect(snapshot.claims[0]?.openAmountPaise).toBe(0);
    expect(snapshot.claims[0]?.status).toBe("settled");
    expect(snapshot.postings.some((posting) => posting.pnl === "expense")).toBe(false);
  });

  it("D — partial payable", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    borrowMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 300_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    paySettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 100_000,
      allocations: [{ claimId: claim.id, amountPaise: 100_000 }],
      commit: true,
    });
    expect(loadSnapshot(ctx.handles, ctx.workspaceId).claims[0]?.openAmountPaise).toBe(200_000);
  });

  it("E — multiple claims", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 150_000);
    lend(ctx, ctx.rahulId, 200_000);
    const [first, second] = loadSnapshot(ctx.handles, ctx.workspaceId).claims;
    if (!first || !second) throw new Error("missing claims");
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      allocations: [
        { claimId: first.id, amountPaise: 150_000 },
        { claimId: second.id, amountPaise: 100_000 },
      ],
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    const a = snapshot.claims.find((claim) => claim.id === first.id);
    const b = snapshot.claims.find((claim) => claim.id === second.id);
    expect(a?.status).toBe("settled");
    expect(b?.openAmountPaise).toBe(100_000);
    expect(snapshot.claims).toHaveLength(2);
  });

  it("F — mixed claim kinds in one settlement", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 400_000,
      source: { type: "card", creditCardId: ctx.cardId },
      userSharePaise: 150_000,
      personShares: [{ personId: ctx.rahulId, amountPaise: 250_000 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 150_000 }],
      commit: true,
    });
    recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 200_000,
      source: { type: "account", accountId: ctx.hdfcId },
      userSharePaise: 100_000,
      personShares: [{ personId: ctx.rahulId, amountPaise: 100_000 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 100_000 }],
      merchant: "Restaurant",
      commit: true,
    });
    lend(ctx, ctx.rahulId, 50_000);
    const snapshotBefore = loadSnapshot(ctx.handles, ctx.workspaceId);
    const cardShare = snapshotBefore.claims.find((claim) => claim.kind === "card_share");
    const sharedBill = snapshotBefore.claims.find((claim) => claim.kind === "shared_bill");
    const loan = snapshotBefore.claims.find((claim) => claim.kind === "direct_loan");
    if (!cardShare || !sharedBill || !loan) throw new Error("missing mixed claims");
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 400_000,
      allocations: [
        { claimId: cardShare.id, amountPaise: 250_000 },
        { claimId: sharedBill.id, amountPaise: 100_000 },
        { claimId: loan.id, amountPaise: 50_000 },
      ],
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.claims.find((claim) => claim.id === cardShare.id)?.openAmountPaise).toBe(0);
    expect(after.claims.find((claim) => claim.id === sharedBill.id)?.openAmountPaise).toBe(0);
    expect(after.claims.find((claim) => claim.id === loan.id)?.openAmountPaise).toBe(0);
    expect(after.claims).toHaveLength(3);
  });

  it("G — over-allocation rejected with no writes", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 100_000);
    const before = tableCounts(ctx.handles, ctx.workspaceId);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    expect(() =>
      receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        accountId: ctx.hdfcId,
        personId: ctx.rahulId,
        amountPaise: 120_000,
        allocations: [{ claimId: claim.id, amountPaise: 120_000 }],
        commit: true,
      }),
    ).toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(before);
  });

  it("H — under-allocation creates pending surplus", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 200_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 200_000,
      allocations: [{ claimId: claim.id, amountPaise: 150_000 }],
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.claims[0]?.openAmountPaise).toBe(50_000);
    expect(snapshot.surplusCases).toHaveLength(1);
    expect(snapshot.surplusCases[0]?.amountPaise).toBe(50_000);
    expect(snapshot.surplusCases[0]?.status).toBe("pending");
  });

  it("I — incoming settlement cannot allocate to a payable", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    borrowMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 100_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    expect(() =>
      receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        accountId: ctx.hdfcId,
        personId: ctx.rahulId,
        amountPaise: 100_000,
        allocations: [{ claimId: claim.id, amountPaise: 100_000 }],
        commit: true,
      }),
    ).toThrow(/wrong claim direction/);
  });

  it("J — cannot allocate Rahul's settlement to Amit's claim", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 100_000);
    lend(ctx, ctx.amitId, 100_000);
    const amitClaim = loadSnapshot(ctx.handles, ctx.workspaceId).claims.find(
      (claim) => claim.personId === ctx.amitId,
    );
    if (!amitClaim) throw new Error("missing amit claim");
    expect(() =>
      receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        accountId: ctx.hdfcId,
        personId: ctx.rahulId,
        amountPaise: 100_000,
        allocations: [{ claimId: amitClaim.id, amountPaise: 100_000 }],
        commit: true,
      }),
    ).toThrow(/different person/);
  });

  it("K — duplicate claim allocation rejected", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 200_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    expect(() =>
      receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        accountId: ctx.hdfcId,
        personId: ctx.rahulId,
        amountPaise: 200_000,
        allocations: [
          { claimId: claim.id, amountPaise: 100_000 },
          { claimId: claim.id, amountPaise: 100_000 },
        ],
        commit: true,
      }),
    ).toThrow(/allocated twice/);
  });

  it("L — settlement is not income or spending", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 300_000,
      source: { type: "account", accountId: ctx.hdfcId },
      userSharePaise: 120_000,
      personShares: [{ personId: ctx.rahulId, amountPaise: 180_000 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 120_000 }],
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    const before = monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 180_000,
      allocations: [{ claimId: claim.id, amountPaise: 180_000 }],
      commit: true,
    });
    const after = monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    expect(before.spentPaise).toBe(120_000);
    expect(after.spentPaise).toBe(120_000);
    const activity = listActivity(ctx.handles, ctx.workspaceId).find((event) => event.meaning === "settlement_in");
    expect(activity?.counterpartyName).toBe("Rahul");
    expect(activity?.allocations[0]?.amountPaise).toBe(180_000);
  });

  it("M — card-share receipt does not change card liability", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 400_000,
      source: { type: "card", creditCardId: ctx.cardId },
      userSharePaise: 150_000,
      personShares: [{ personId: ctx.rahulId, amountPaise: 250_000 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 150_000 }],
      commit: true,
    });
    const before = loadSnapshot(ctx.handles, ctx.workspaceId);
    const claim = before.claims[0];
    const cycle = before.billingCycles[0];
    if (!claim || !cycle) throw new Error("missing card claim");
    const liabilityBefore = before.postings
      .filter((posting) => posting.creditCardId === ctx.cardId)
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      allocations: [{ claimId: claim.id, amountPaise: 250_000 }],
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const liabilityAfter = after.postings
      .filter((posting) => posting.creditCardId === ctx.cardId)
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(after.claims[0]?.openAmountPaise).toBe(0);
    expect(liabilityAfter).toBe(liabilityBefore);
    expect(after.billingCycles[0]?.ledgerRemainingPaise).toBe(cycle.ledgerRemainingPaise);
    expect(after.settlementAllocations[0]?.createsReservation).toBe(true);
    expect(after.reservations).toHaveLength(1);
    expect(after.reservations[0]?.remainingPaise).toBe(250_000);
  });

  it("N — person net updates from incoming and outgoing settlements", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 300_000);
    borrowMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 100_000,
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    const receivable = snapshot.claims.find((claim) => claim.direction === "they_owe_user");
    const payable = snapshot.claims.find((claim) => claim.direction === "user_owes_them");
    if (!receivable || !payable) throw new Error("missing claims");
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 200_000,
      allocations: [{ claimId: receivable.id, amountPaise: 200_000 }],
      commit: true,
    });
    paySettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 40_000,
      allocations: [{ claimId: payable.id, amountPaise: 40_000 }],
      commit: true,
    });
    const position = personPosition(loadSnapshot(ctx.handles, ctx.workspaceId).claims, ctx.rahulId);
    expect(position.theyOwePaise).toBe(100_000);
    expect(position.youOwePaise).toBe(60_000);
    expect(position.netPaise).toBe(40_000);
    expect(position.openItemCount).toBe(2);
    const detail = personDetail(ctx.handles, ctx.workspaceId, ctx.rahulId);
    expect(detail.netPaise).toBe(40_000);
    expect(detail.claims).toHaveLength(2);
  });

  it("O — suggestion is pure and confirmed allocations are respected", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 150_000);
    lend(ctx, ctx.rahulId, 200_000);
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    const beforeCounts = tableCounts(ctx.handles, ctx.workspaceId);
    const suggested = suggestAllocations(
      suggestableClaimsFor(snapshot, ctx.rahulId, "they_owe_user"),
      paise(250_000),
    );
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(beforeCounts);
    expect(suggested.reduce((sum, item) => sum + item.amountPaise, 0)).toBe(250_000);
    expect(suggested.every((item) => {
      const claim = snapshot.claims.find((row) => row.id === item.claimId);
      return claim !== undefined && item.amountPaise <= claim.openAmountPaise;
    })).toBe(true);
    const [first, second] = snapshot.claims;
    if (!first || !second) throw new Error("missing claims");
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      allocations: [
        { claimId: second.id, amountPaise: 200_000 },
        { claimId: first.id, amountPaise: 50_000 },
      ],
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.claims.find((claim) => claim.id === second.id)?.openAmountPaise).toBe(0);
    expect(after.claims.find((claim) => claim.id === first.id)?.openAmountPaise).toBe(100_000);
  });

  it("P — invalid allocation is atomic", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lend(ctx, ctx.rahulId, 100_000);
    const before = tableCounts(ctx.handles, ctx.workspaceId);
    const startingBalance = balance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    expect(() =>
      receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        accountId: ctx.hdfcId,
        personId: ctx.rahulId,
        amountPaise: 100_000,
        allocations: [{ claimId: claim.id, amountPaise: 120_000 }],
        commit: true,
      }),
    ).toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(before);
    expect(balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(startingBalance);
    expect(loadSnapshot(ctx.handles, ctx.workspaceId).claims[0]?.status).toBe("open");
  });
});
