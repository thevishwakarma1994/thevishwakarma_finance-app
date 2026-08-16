import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { personPosition } from "../../src/domain/people/position.js";
import { accountAvailability } from "../../src/domain/engine/liquidity.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { cycleDetail, listActivity, listAccounts, monthReview, personDetail } from "../../src/db/reads.js";
import {
  claims,
  financialEvents,
  postings,
  reservationLedger,
  reservations,
  surplusCases,
} from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { createAccount } from "../../src/app/accounts.js";
import { createCard } from "../../src/app/cards.js";
import { createPerson } from "../../src/app/people.js";
import { lendMoney } from "../../src/app/lendMoney.js";
import { recordSplit } from "../../src/app/recordSplit.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { recordExpense } from "../../src/app/recordExpense.js";
import { transferMoney } from "../../src/app/transferMoney.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";
import { payCard } from "../../src/app/payCard.js";
import { confirmStatement } from "../../src/app/confirmStatement.js";
import { resolveSurplus } from "../../src/app/resolveSurplus.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

function setup(openingPaise = 400_000) {
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
    balancePaise: openingPaise,
    commit: true,
  });
  const pnb = createAccount(handles, { workspaceId }, {
    displayName: "PNB",
    kind: "bank",
    openingBalancePaise: 1_000_000,
    openingEffectiveOn: "2026-08-01",
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
  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    pnbId: pnb.id,
    groceryId: grocery.id,
    cardId: card.id,
    rahulId: rahul.id,
  };
}

function tableCounts(handles: SqliteHandles, workspaceId: string) {
  return {
    events:
      handles.db.select({ value: count() }).from(financialEvents).where(eq(financialEvents.workspaceId, workspaceId)).get()?.value ?? 0,
    postings:
      handles.db.select({ value: count() }).from(postings).where(eq(postings.workspaceId, workspaceId)).get()?.value ?? 0,
    reservations:
      handles.db.select({ value: count() }).from(reservations).where(eq(reservations.workspaceId, workspaceId)).get()?.value ?? 0,
    ledger:
      handles.db.select({ value: count() }).from(reservationLedger).where(eq(reservationLedger.workspaceId, workspaceId)).get()?.value ?? 0,
    surplus:
      handles.db.select({ value: count() }).from(surplusCases).where(eq(surplusCases.workspaceId, workspaceId)).get()?.value ?? 0,
    claims:
      handles.db.select({ value: count() }).from(claims).where(eq(claims.workspaceId, workspaceId)).get()?.value ?? 0,
  };
}

function avail(handles: SqliteHandles, workspaceId: string, accountId: string) {
  return accountAvailability(loadSnapshot(handles, workspaceId), accountId);
}

function cardShare(ctx: ReturnType<typeof setup>, amountPaise: number, rahulPaise: number, userPaise: number) {
  return recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
    occurredOn: "2026-08-16",
    capturedAt,
    amountPaise,
    source: { type: "card", creditCardId: ctx.cardId },
    userSharePaise: userPaise,
    personShares: [{ personId: ctx.rahulId, amountPaise: rahulPaise }],
    allocations: userPaise > 0 ? [{ categoryId: ctx.groceryId, amountPaise: userPaise }] : [],
    commit: true,
  });
}

function collect(ctx: ReturnType<typeof setup>, claimId: string, amountPaise: number, allocatedPaise = amountPaise) {
  return receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
    occurredOn: "2026-08-16",
    capturedAt,
    accountId: ctx.hdfcId,
    personId: ctx.rahulId,
    amountPaise,
    allocations: [{ claimId, amountPaise: allocatedPaise }],
    commit: true,
  });
}

describe("stage 11 reservations and surplus", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("A — card collection reservation", () => {
    const ctx = setup(400_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const before = loadSnapshot(ctx.handles, ctx.workspaceId);
    const claim = before.claims[0];
    const liabilityBefore = before.billingCycles[0]?.ledgerRemainingPaise;
    if (!claim) throw new Error("missing claim");
    const availableBefore = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise;
    collect(ctx, claim.id, 250_000);
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const hdfc = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    expect(hdfc.balancePaise).toBe(650_000);
    expect(after.reservations[0]?.remainingPaise).toBe(250_000);
    expect(hdfc.availablePaise).toBe(availableBefore);
    expect(after.billingCycles[0]?.ledgerRemainingPaise).toBe(liabilityBefore);
    expect(after.settlementAllocations[0]?.createsReservation).toBe(true);
  });

  it("B — partial collection", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 100_000);
    expect(loadSnapshot(ctx.handles, ctx.workspaceId).reservations[0]?.remainingPaise).toBe(100_000);
  });

  it("C — mixed settlement", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 150_000,
      commit: true,
    });
    const snapshot = loadSnapshot(ctx.handles, ctx.workspaceId);
    const cardClaim = snapshot.claims.find((claim) => claim.kind === "card_share");
    const loan = snapshot.claims.find((claim) => claim.kind === "direct_loan");
    if (!cardClaim || !loan) throw new Error("missing claims");
    const availableBefore = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise;
    receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 400_000,
      allocations: [
        { claimId: cardClaim.id, amountPaise: 250_000 },
        { claimId: loan.id, amountPaise: 150_000 },
      ],
      commit: true,
    });
    const hdfc = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    expect(loadSnapshot(ctx.handles, ctx.workspaceId).reservations[0]?.remainingPaise).toBe(250_000);
    expect(hdfc.availablePaise).toBe(availableBefore + 150_000);
  });

  it("D — card already paid", () => {
    const ctx = setup(1_000_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const before = loadSnapshot(ctx.handles, ctx.workspaceId);
    const claim = before.claims[0];
    const cycle = before.billingCycles[0];
    if (!claim || !cycle) throw new Error("missing cycle");
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycle.id,
      accountId: ctx.hdfcId,
      amountPaise: cycle.remainingPaise,
      commit: true,
    });
    const availableBefore = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise;
    collect(ctx, claim.id, 250_000);
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.reservations).toHaveLength(0);
    expect(after.settlementAllocations[0]?.createsReservation).toBe(false);
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise).toBe(availableBefore + 250_000);
  });

  it("E — ordinary spend protection", () => {
    const ctx = setup(400_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 800_000, 600_000, 200_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 600_000);
    const hdfc = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    expect(hdfc.balancePaise).toBe(1_000_000);
    expect(hdfc.reservedActivePaise).toBe(600_000);
    expect(hdfc.availablePaise).toBe(400_000);
    expect(() =>
      recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        accountId: ctx.hdfcId,
        allocations: [{ categoryId: ctx.groceryId, amountPaise: 500_000 }],
        commit: true,
      }),
    ).toThrow(DomainError);
  });

  it("F — transfer protection", () => {
    const ctx = setup(400_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 800_000, 600_000, 200_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 600_000);
    expect(() =>
      transferMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        amountPaise: 500_000,
        fromAccountId: ctx.hdfcId,
        toAccountId: ctx.pnbId,
        commit: true,
      }),
    ).toThrow(DomainError);
  });

  it("G — same-account card payment consumes reservation first", () => {
    const ctx = setup(400_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 800_000, 600_000, 200_000);
    const before = loadSnapshot(ctx.handles, ctx.workspaceId);
    const claim = before.claims[0];
    const cycle = before.billingCycles[0];
    if (!claim || !cycle) throw new Error("missing");
    collect(ctx, claim.id, 600_000);
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycle.id,
      accountId: ctx.hdfcId,
      amountPaise: 800_000,
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.reservations[0]?.amountConsumedPaise).toBe(600_000);
    expect(after.reservations[0]?.remainingPaise).toBe(0);
    expect(after.reservationLedger.some((entry) => entry.deltaConsumedPaise === 600_000)).toBe(true);
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise).toBe(200_000);
    expect(after.billingCycles[0]?.ledgerRemainingPaise).toBe(0);
  });

  it("H — different-account full payment releases reservation", () => {
    const ctx = setup(400_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 600_000, 600_000, 0);
    const before = loadSnapshot(ctx.handles, ctx.workspaceId);
    const claim = before.claims[0];
    const cycle = before.billingCycles[0];
    if (!claim || !cycle) throw new Error("missing");
    collect(ctx, claim.id, 600_000);
    const availableBefore = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise;
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycle.id,
      accountId: ctx.pnbId,
      amountPaise: 600_000,
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.reservations[0]?.amountReleasedPaise).toBe(600_000);
    expect(after.reservations[0]?.remainingPaise).toBe(0);
    expect(after.surplusCases).toHaveLength(0);
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise).toBe(availableBefore + 600_000);
  });

  it("I — different-account partial payment releases only what is no longer required", () => {
    const ctx = setup(400_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 600_000, 600_000, 0);
    const before = loadSnapshot(ctx.handles, ctx.workspaceId);
    const claim = before.claims[0];
    const cycle = before.billingCycles[0];
    if (!claim || !cycle) throw new Error("missing");
    collect(ctx, claim.id, 600_000);
    payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: cycle.id,
      accountId: ctx.pnbId,
      amountPaise: 200_000,
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.reservations[0]?.amountReleasedPaise).toBe(200_000);
    expect(after.reservations[0]?.remainingPaise).toBe(400_000);
    expect(after.surplusCases).toHaveLength(0);
  });

  it("J — incoming overpayment creates pending surplus", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const hdfc = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    expect(after.surplusCases[0]?.amountPaise).toBe(50_000);
    expect(after.surplusCases[0]?.status).toBe("pending");
    expect(hdfc.balancePaise).toBe(700_000);
    expect(hdfc.availablePaise).toBe(hdfc.balancePaise - hdfc.reservedActivePaise - hdfc.pendingSurplusHeldPaise);
    expect(hdfc.pendingSurplusHeldPaise).toBe(50_000);
    expect(hdfc.availablePaise).toBe(400_000);
  });

  it("K — claim allocation cannot exceed open amount", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    expect(() => collect(ctx, claim.id, 250_000, 300_000)).toThrow(DomainError);
  });

  it("L — apply surplus to another claim", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 250_000, 250_000, 0);
    cardShare(ctx, 150_000, 150_000, 0);
    const claimsBefore = loadSnapshot(ctx.handles, ctx.workspaceId).claims;
    const first = claimsBefore[0];
    const second = claimsBefore[1];
    if (!first || !second) throw new Error("missing claims");
    collect(ctx, first.id, 300_000, 250_000);
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases[0];
    if (!surplus) throw new Error("missing surplus");
    resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "apply_to_other_claim",
      claimId: second.id,
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.claims.find((claim) => claim.id === second.id)?.openAmountPaise).toBe(100_000);
    expect(after.surplusCases[0]?.status).toBe("resolved");
    expect(after.reservations.some((reservation) => reservation.originatingClaimId === second.id)).toBe(true);
  });

  it("M — convert surplus to payable", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases[0];
    if (!surplus) throw new Error("missing surplus");
    resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "convert_to_payable",
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const payable = after.claims.find((item) => item.kind === "surplus_payable");
    expect(payable?.originalAmountPaise).toBe(50_000);
    expect(payable?.direction).toBe("user_owes_them");
    expect(after.surplusCases[0]?.status).toBe("resolved");
    expect(after.postings.some((posting) => posting.pnl)).toBe(false);
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).pendingSurplusHeldPaise).toBe(0);
  });

  it("N — treat-as-mine", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const before = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases[0];
    if (!surplus) throw new Error("missing surplus");
    expect(() =>
      resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
        surplusCaseId: surplus.id,
        resolution: "treat_as_mine_correction",
        commit: true,
      }),
    ).toThrow(/treat/);
    resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "treat_as_mine_correction",
      confirmed: true,
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.surplusCases[0]?.status).toBe("resolved");
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise).toBe(before.availablePaise + 50_000);
    expect(after.postings.some((posting) => posting.pnl === "income_other" || posting.pnl === "income_salary")).toBe(false);
  });

  it("O — reservation reassignment", () => {
    const ctx = setup(1_000_000);
    contexts.push(ctx.handles);
    const axis = createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "AXIS",
      issuer: "AXIS",
      mask: "4412",
      statementDay: 12,
      dueDaysAfterStatement: 18,
    });
    cardShare(ctx, 250_000, 250_000, 0);
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: axis.id,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 200_000 }],
      commit: true,
    });
    const iciciCycle = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles.find(
      (cycle) => cycle.creditCardId === ctx.cardId,
    );
    const axisCycle = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles.find(
      (cycle) => cycle.creditCardId === axis.id,
    );
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim || !iciciCycle || !axisCycle) throw new Error("missing cycles");
    collect(ctx, claim.id, 250_000);
    confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId: iciciCycle.id,
      actualStatementAmountPaise: 0,
      actualStatementOn: "2026-09-12",
      actualDueOn: "2026-09-30",
    });
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases.find(
      (item) => item.kind === "reservation_excess",
    );
    if (!surplus) throw new Error("missing reservation excess");
    resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "reassign_reservation",
      billingCycleId: axisCycle.id,
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const source = after.reservations.find((reservation) => reservation.id === surplus.reservationId);
    const target = after.reservations.find(
      (reservation) => reservation.obligationRef.id === axisCycle.id,
    );
    expect(source?.amountReassignedPaise).toBe(200_000);
    expect(target?.remainingPaise).toBe(200_000);
    expect(after.reservationLedger.some((entry) => entry.deltaReassignedPaise === 200_000)).toBe(true);
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).balancePaise).toBe(
      loadSnapshot(ctx.handles, ctx.workspaceId).accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise,
    );
  });

  it("P — pending surplus and reserved are not double-counted", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const hdfc = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    expect(hdfc.reservedActivePaise + hdfc.pendingSurplusHeldPaise).toBe(300_000);
    expect(hdfc.availablePaise).toBe(hdfc.balancePaise - hdfc.reservedActivePaise - hdfc.pendingSurplusHeldPaise);
    expect(hdfc.availablePaise).toBe(400_000);
  });

  it("Q — person net is unaffected by reservation itself", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 250_000);
    const position = personPosition(loadSnapshot(ctx.handles, ctx.workspaceId).claims, ctx.rahulId);
    expect(position.netPaise).toBe(0);
    expect(loadSnapshot(ctx.handles, ctx.workspaceId).reservations[0]?.remainingPaise).toBe(250_000);
    expect(personDetail(ctx.handles, ctx.workspaceId, ctx.rahulId).netPaise).toBe(0);
  });

  it("R — Month Review unaffected by reservation/surplus", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const before = monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const after = monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    expect(after.spentPaise).toBe(before.spentPaise);
    expect(after.spentPaise).toBe(150_000);
  });

  it("S — invalid reservation/surplus transition is atomic", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const before = tableCounts(ctx.handles, ctx.workspaceId);
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases[0];
    if (!surplus) throw new Error("missing surplus");
    expect(() =>
      resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
        surplusCaseId: surplus.id,
        resolution: "apply_to_other_claim",
        claimId: "missing-claim",
        commit: true,
      }),
    ).toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(before);
  });
});

describe("stage 11 read models", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("exposes reserved/available and settlement consequences", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    cardShare(ctx, 400_000, 250_000, 150_000);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    const cycle = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles[0];
    if (!claim || !cycle) throw new Error("missing");
    collect(ctx, claim.id, 250_000);
    const accounts = listAccounts(ctx.handles, ctx.workspaceId);
    const hdfc = accounts.find((account) => account.id === ctx.hdfcId);
    expect(hdfc?.reservedPaise).toBe(250_000);
    expect(hdfc?.availablePaise).toBe(400_000);
    expect(hdfc?.reservedDetails[0]?.cardLabel).toContain("ICICI");
    const activity = listActivity(ctx.handles, ctx.workspaceId).find((event) => event.meaning === "settlement_in");
    expect(activity?.consequences?.some((item) => item.kind === "reserved")).toBe(true);
    const detail = cycleDetail(ctx.handles, ctx.workspaceId, cycle.id);
    expect(detail.reservedTowardCyclePaise).toBe(250_000);
    expect(detail.unfundedPaise).toBe(150_000);
  });
});

describe("stage 11 surplus resolution event identity", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("A — surplus on date A resolved on date B has a distinct resolution event", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const before = loadSnapshot(ctx.handles, ctx.workspaceId);
    const surplus = before.surplusCases[0];
    const originId = surplus?.eventId;
    if (!surplus || !originId) throw new Error("missing surplus origin");
    const originBefore = ctx.handles.db.select().from(financialEvents).where(eq(financialEvents.id, originId)).get();
    const originPostingsBefore = ctx.handles.db
      .select()
      .from(postings)
      .where(eq(postings.eventId, originId))
      .all();
    const resolved = resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "treat_as_mine_correction",
      confirmed: true,
      occurredOn: "2026-09-20",
      capturedAt: "2026-09-20T10:00:00.000Z",
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const resolvedCase = after.surplusCases.find((item) => item.id === surplus.id);
    const resolution = after.events.find((event) => event.id === resolved.eventId);
    const originAfter = ctx.handles.db.select().from(financialEvents).where(eq(financialEvents.id, originId)).get();
    const originPostingsAfter = ctx.handles.db
      .select()
      .from(postings)
      .where(eq(postings.eventId, originId))
      .all();
    expect(resolved.eventId).toBeTruthy();
    expect(resolved.eventId).not.toBe(originId);
    expect(originAfter).toEqual(originBefore);
    expect(originPostingsAfter).toEqual(originPostingsBefore);
    expect(originAfter?.occurredOn).toBe("2026-08-16");
    expect(originAfter?.meaning).toBe("settlement_in");
    expect(resolvedCase?.eventId).toBe(originId);
    expect(resolvedCase?.id).toBe(surplus.id);
    expect(resolvedCase?.status).toBe("resolved");
    expect(resolvedCase?.resolvedByEventId).toBe(resolved.eventId);
    expect(resolution?.meaning).toBe("surplus_resolution");
    expect(resolution?.occurredOn).toBe("2026-09-20");
  });

  it("B — reservation reassignment ledger references the resolution event", () => {
    const ctx = setup(1_000_000);
    contexts.push(ctx.handles);
    const axis = createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "AXIS",
      issuer: "AXIS",
      mask: "4412",
      statementDay: 12,
      dueDaysAfterStatement: 18,
    });
    cardShare(ctx, 250_000, 250_000, 0);
    recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: axis.id,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 250_000 }],
      commit: true,
    });
    const iciciCycle = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles.find(
      (cycle) => cycle.creditCardId === ctx.cardId,
    );
    const axisCycle = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles.find(
      (cycle) => cycle.creditCardId === axis.id,
    );
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim || !iciciCycle || !axisCycle) throw new Error("missing cycles");
    collect(ctx, claim.id, 250_000);
    confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId: iciciCycle.id,
      actualStatementAmountPaise: 0,
      actualStatementOn: "2026-09-12",
      actualDueOn: "2026-09-30",
    });
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases.find(
      (item) => item.kind === "reservation_excess",
    );
    if (!surplus) throw new Error("missing reservation excess");
    const originEventId = surplus.eventId;
    const resolved = resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "reassign_reservation",
      billingCycleId: axisCycle.id,
      occurredOn: "2026-09-20",
      capturedAt: "2026-09-20T10:00:00.000Z",
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const reassignment = after.reservationLedger.find((entry) => entry.deltaReassignedPaise === 250_000);
    const target = after.reservations.find((reservation) => reservation.obligationRef.id === axisCycle.id);
    expect(resolved.eventId).not.toBe(originEventId);
    expect(reassignment?.eventId).toBe(resolved.eventId);
    expect(reassignment?.eventId).not.toBe(originEventId);
    expect(target?.originatingEventId).toBe(resolved.eventId);
    expect(after.surplusCases.find((item) => item.id === surplus.id)?.resolvedByEventId).toBe(resolved.eventId);
  });

  it("C — convert to payable remains traceable to the resolution event", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases[0];
    if (!surplus) throw new Error("missing surplus");
    const resolved = resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "convert_to_payable",
      occurredOn: "2026-09-20",
      capturedAt: "2026-09-20T10:00:00.000Z",
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const payable = after.claims.find((item) => item.kind === "surplus_payable");
    const resolvedCase = after.surplusCases.find((item) => item.id === surplus.id);
    expect(resolved.eventId).not.toBe(surplus.eventId);
    expect(payable?.originatingEventId).toBe(resolved.eventId);
    expect(resolvedCase?.eventId).toBe(surplus.eventId);
    expect(resolvedCase?.resolvedByEventId).toBe(resolved.eventId);
  });

  it("D — treat-as-mine has a distinct resolution event and no P&L", () => {
    const ctx = setup();
    contexts.push(ctx.handles);
    lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 250_000,
      commit: true,
    });
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    if (!claim) throw new Error("missing claim");
    collect(ctx, claim.id, 300_000, 250_000);
    const before = avail(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases[0];
    if (!surplus) throw new Error("missing surplus");
    const resolved = resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
      surplusCaseId: surplus.id,
      resolution: "treat_as_mine_correction",
      confirmed: true,
      occurredOn: "2026-09-20",
      capturedAt: "2026-09-20T10:00:00.000Z",
      commit: true,
    });
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    const resolutionPostings = after.postings.filter((posting) => posting.eventId === resolved.eventId);
    expect(resolved.eventId).not.toBe(surplus.eventId);
    expect(after.events.find((event) => event.id === resolved.eventId)?.meaning).toBe("surplus_resolution");
    expect(resolutionPostings).toHaveLength(0);
    expect(after.postings.some((posting) => posting.pnl === "income_other" || posting.pnl === "income_salary")).toBe(false);
    expect(after.postings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect(after.surplusCases[0]?.resolvedByEventId).toBe(resolved.eventId);
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).pendingSurplusHeldPaise).toBe(0);
    expect(avail(ctx.handles, ctx.workspaceId, ctx.hdfcId).availablePaise).toBe(before.availablePaise + 50_000);
  });

  it("E — failed resolution writes no resolution event or ledger mutation", () => {
    const ctx = setup(1_000_000);
    contexts.push(ctx.handles);
    cardShare(ctx, 250_000, 250_000, 0);
    const claim = loadSnapshot(ctx.handles, ctx.workspaceId).claims[0];
    const cycle = loadSnapshot(ctx.handles, ctx.workspaceId).billingCycles[0];
    if (!claim || !cycle) throw new Error("missing");
    collect(ctx, claim.id, 250_000);
    confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId: cycle.id,
      actualStatementAmountPaise: 0,
      actualStatementOn: "2026-09-12",
      actualDueOn: "2026-09-30",
    });
    const before = tableCounts(ctx.handles, ctx.workspaceId);
    const surplus = loadSnapshot(ctx.handles, ctx.workspaceId).surplusCases.find(
      (item) => item.kind === "reservation_excess",
    );
    if (!surplus) throw new Error("missing reservation excess");
    expect(() =>
      resolveSurplus(ctx.handles, { workspaceId: ctx.workspaceId }, {
        surplusCaseId: surplus.id,
        resolution: "reassign_reservation",
        commit: true,
      }),
    ).toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(before);
    const after = loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.events.some((event) => event.meaning === "surplus_resolution")).toBe(false);
    expect(after.reservationLedger.filter((entry) => entry.deltaReassignedPaise > 0)).toHaveLength(0);
    const pending = after.surplusCases.find((item) => item.id === surplus.id);
    expect(pending?.status).toBe("pending");
    expect(pending?.resolvedByEventId).toBeNull();
  });
});
