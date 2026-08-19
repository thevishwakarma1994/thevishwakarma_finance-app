import { type IsoDate } from "../../src/domain/calendar/isoDate.js";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { personDetail, cardDetail } from "../../src/db/reads.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { paymentCap } from "../../src/domain/cycle/lifecycle.js";
import { confirmStatement } from "../../src/app/confirmStatement.js";

import { applyOpening } from "../../src/app/applyOpening.js";
import { applyOpeningCard } from "../../src/app/openingCard.js";
import { applyOpeningClaim } from "../../src/app/openingClaim.js";
import { applyOpeningReservation } from "../../src/app/openingReservation.js";
import { createCard } from "../../src/app/cards.js";
import { createPerson } from "../../src/app/people.js";
import { payCard } from "../../src/app/payCard.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";
import { paySettlement } from "../../src/app/paySettlement.js";


const capturedAt = "2026-08-16T10:00:00.000Z";

describe("phase 16a lifecycle", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("exact ₹50K acceptance lifecycle with explicit card-cycle assertions", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);
    const workspaceId = await getSoleWorkspaceId(handles);
    const snapshot = await loadSnapshot(handles, workspaceId);
    const hdfcId = snapshot.accounts.find((account) => account.displayName === "HDFC")!.id;

    // ── ACCOUNT: real opening balance ₹50,000 ──
    await applyOpening(handles, { workspaceId }, {
      accountId: hdfcId,
      effectiveOn: "2026-08-01" as IsoDate,
      balancePaise: 50_000_00,
      commit: true,
    });

    // ── CARD: brand-new card, no preseeded cycle ──
    const card = await createCard(handles, { workspaceId }, {
      displayName: "Amex",
      issuer: "Amex",
      mask: "1001",
      statementDay: 10,
      dueDaysAfterStatement: 20,
      defaultPaymentAccountId: hdfcId,
    });

    // A brand-new card starts with no billing cycle at all.
    expect((await loadSnapshot(handles, workspaceId)).billingCycles).toHaveLength(0);

    // Opening debt ₹20,000 — cycle is auto-resolved by production flow
    await applyOpeningCard(handles, { workspaceId }, {
      commandId: "cmd-open-card",
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: card.id,
      amountPaise: 20_000_00,
    });

    // Exactly one cycle was materialized by the production resolve flow
    const snapCard = await loadSnapshot(handles, workspaceId);
    expect(snapCard.billingCycles).toHaveLength(1);
    const cycleId = snapCard.billingCycles[0]!.id;

    // ── CONFIRM STATEMENT ₹20,000 ──
    await confirmStatement(handles, { workspaceId }, {
      cycleId,
      actualStatementAmountPaise: 20_000_00,
      actualStatementOn: "2026-08-10",
      actualDueOn: "2026-08-30",
    });

    // The three named card-cycle values, from the real production derivation.
    const snapAfterStatement = await loadSnapshot(handles, workspaceId);
    const cycleAfterStatement = snapAfterStatement.billingCycles.find(c => c.id === cycleId)!;
    expect(cycleAfterStatement.ledgerRemainingPaise).toBe(20_000_00);
    expect(cycleAfterStatement.statementRemainingPaise).toBe(20_000_00);
    expect(
      paymentCap(
        cycleAfterStatement.ledgerRemainingPaise,
        cycleAfterStatement.statementRemainingPaise,
      ),
    ).toBe(20_000_00);
    expect(cycleAfterStatement.remainingPaise).toBe(20_000_00);
    expect(cycleAfterStatement.mismatch).toBe(false);

    // ── CLAIMS ──
    const rahul = await createPerson(handles, { workspaceId }, { name: "Rahul" });
    await applyOpeningClaim(handles, { workspaceId }, {
      commandId: "cmd-open-rec",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: rahul.id,
      direction: "they_owe_user",
      amountPaise: 10_000_00,
    });
    const claimReceivable = "cmd-open-rec_claim";

    await applyOpeningClaim(handles, { workspaceId }, {
      commandId: "cmd-open-pay",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: rahul.id,
      direction: "user_owes_them",
      amountPaise: 4_000_00,
    });
    const claimPayable = "cmd-open-pay_claim";

    // ── EARMARK ₹5,000 ──
    await applyOpeningReservation(handles, { workspaceId }, {
      commandId: "cmd-open-res",
      occurredOn: "2026-08-05",
      capturedAt,
      sourceAccountId: hdfcId,
      cardId: card.id,
      billingCycleId: cycleId,
      amountPaise: 5_000_00,
    });

    // ── OPENING CONSERVATION ASSERTIONS ──
    const snap1 = await loadSnapshot(handles, workspaceId);

    // No PnL from any opening
    const expense = snap1.postings.filter(p => p.pnl === "expense").reduce((acc, p) => acc + p.amountPaise, 0);
    const income = snap1.postings.filter(p => p.pnl?.startsWith("income")).reduce((acc, p) => acc + p.amountPaise, 0);
    expect(expense).toBe(0);
    expect(income).toBe(0);
    expect(snap1.settlementAllocations.length).toBe(0);

    // Every event so far is an opening, and no opening moved money in an account.
    const openingEventIds = new Set(
      snap1.events.filter(e => e.meaning.includes("opening")).map(e => e.id),
    );
    expect(snap1.events.map(e => e.id).sort()).toEqual([...openingEventIds].sort());
    expect(
      snap1.postings.filter(p => openingEventIds.has(p.eventId) && p.accountId !== null),
    ).toHaveLength(0);

    // Bank assertions
    const bank = snap1.accounts.find(a => a.id === hdfcId)!;
    expect(bank.balancePaise).toBe(50_000_00);

    const sts = evaluateSafeToSpend(snap1, "2026-08-11" as IsoDate);
    expect(sts.reservedTotal).toBe(5_000_00);
    expect(sts.availableLiquid).toBe(45_000_00);

    // Card detail assertions
    const cDetail = await cardDetail(handles, workspaceId, card.id, "2026-08-11" as IsoDate);
    expect(cDetail.outstandingPaise).toBe(20_000_00);
    expect(cDetail.cycles[0]!.ledgerRemainingPaise).toBe(20_000_00);
    expect(cDetail.cycles[0]!.statementRemainingPaise).toBe(20_000_00);
    expect(cDetail.cycles[0]!.remainingPaise).toBe(20_000_00); // paymentCap

    // Opening provenance is visible to the UI straight after the real apply.
    expect(cDetail.openingCardState).toEqual({
      hasBaseOpening: true,
      billingCycleId: cycleId,
      currentEffectiveAmountPaise: 20_000_00,
      baseEventId: "cmd-open-card",
      canSetOpening: false,
      canCorrectOpening: true,
    });

    // Claim assertions
    const rDetail = await personDetail(handles, workspaceId, rahul.id);
    expect(rDetail.theyOwePaise).toBe(10_000_00);
    expect(rDetail.youOwePaise).toBe(4_000_00);
    const recClaim = rDetail.claims.find(c => c.id === claimReceivable);
    const payClaim = rDetail.claims.find(c => c.id === claimPayable);
    expect(recClaim?.openAmountPaise).toBe(10_000_00);
    expect(payClaim?.openAmountPaise).toBe(4_000_00);

    // ── REAL CARD PAYMENT ₹20,000 ──
    await payCard(handles, { workspaceId }, {
      occurredOn: "2026-08-22",
      capturedAt,
      creditCardId: card.id,
      billingCycleId: cycleId,
      accountId: hdfcId,
      amountPaise: 20_000_00,
      commit: true,
    });

    const snap2 = await loadSnapshot(handles, workspaceId);
    const bank2 = snap2.accounts.find(a => a.id === hdfcId)!;
    expect(bank2.balancePaise).toBe(30_000_00);

    const sts2 = evaluateSafeToSpend(snap2, "2026-08-23" as IsoDate);
    expect(sts2.reservedTotal).toBe(0);

    // Cycle fully paid
    const cycleAfterPay = snap2.billingCycles.find(c => c.id === cycleId)!;
    expect(cycleAfterPay.ledgerRemainingPaise).toBe(0);
    expect(cycleAfterPay.statementRemainingPaise).toBe(0);
    expect(
      paymentCap(cycleAfterPay.ledgerRemainingPaise, cycleAfterPay.statementRemainingPaise),
    ).toBe(0);
    expect(cycleAfterPay.remainingPaise).toBe(0);
    expect(cycleAfterPay.status).toBe("paid");
    expect(cycleAfterPay.lifecycle).toBe("paid");

    // Card detail confirms zero outstanding
    const cDetail2 = await cardDetail(handles, workspaceId, card.id, "2026-08-23" as IsoDate);
    expect(cDetail2.outstandingPaise).toBe(0);
    expect(cDetail2.cycles[0]!.ledgerRemainingPaise).toBe(0);
    expect(cDetail2.cycles[0]!.statementRemainingPaise).toBe(0);
    expect(cDetail2.cycles[0]!.remainingPaise).toBe(0);

    // Real payment ends the opening window: no correction action remains.
    expect(cDetail2.openingCardState.hasBaseOpening).toBe(true);
    expect(cDetail2.openingCardState.canCorrectOpening).toBe(false);
    expect(cDetail2.openingCardState.canSetOpening).toBe(false);

    // ── RECEIVE SETTLEMENT ₹10,000 ──
    await receiveSettlement(handles, { workspaceId }, {
      occurredOn: "2026-08-25",
      capturedAt,
      personId: rahul.id,
      accountId: hdfcId,
      amountPaise: 10_000_00,
      allocations: [{ claimId: claimReceivable, amountPaise: 10_000_00 }],
      commit: true,
    });
    const snap3 = await loadSnapshot(handles, workspaceId);
    const bank3 = snap3.accounts.find(a => a.id === hdfcId)!;
    expect(bank3.balancePaise).toBe(40_000_00);
    const rDetail2 = await personDetail(handles, workspaceId, rahul.id);
    expect(rDetail2.claims.find(c => c.id === claimReceivable)?.openAmountPaise).toBe(0);

    // ── PAY SETTLEMENT ₹4,000 ──
    await paySettlement(handles, { workspaceId }, {
      occurredOn: "2026-08-25",
      capturedAt,
      personId: rahul.id,
      accountId: hdfcId,
      amountPaise: 4_000_00,
      allocations: [{ claimId: claimPayable, amountPaise: 4_000_00 }],
      commit: true,
    });
    const snap4 = await loadSnapshot(handles, workspaceId);
    const bank4 = snap4.accounts.find(a => a.id === hdfcId)!;
    expect(bank4.balancePaise).toBe(36_000_00);
    const rDetail3 = await personDetail(handles, workspaceId, rahul.id);
    expect(rDetail3.claims.find(c => c.id === claimPayable)?.openAmountPaise).toBe(0);
  });
});
