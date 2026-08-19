import { type IsoDate } from "../../src/domain/calendar/isoDate.js";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { personDetail, cardDetail } from "../../src/db/reads.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";

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

  it("simulates full onboarding and ensures no fake PnL or cash movement", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);
    const workspaceId = await getSoleWorkspaceId(handles);
    const snapshot = await loadSnapshot(handles, workspaceId);
    const hdfcId = snapshot.accounts.find((account) => account.displayName === "HDFC")!.id;

    // 1. ACCOUNT
    await applyOpening(handles, { workspaceId }, {
      accountId: hdfcId,
      effectiveOn: "2026-08-01" as IsoDate,
      balancePaise: 50_000_00, // ₹50,000
      commit: true,
    });

    // 2. CARD
    const card = await createCard(handles, { workspaceId }, {
      displayName: "Amex",
      issuer: "Amex",
      mask: "1001",
      statementDay: 10,
      dueDaysAfterStatement: 20,
      defaultPaymentAccountId: hdfcId,
    });
    
    // Set Opening Debt on Card
    await applyOpeningCard(handles, { workspaceId }, {
      commandId: "cmd-open-card",
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: card.id,
      amountPaise: 20_000_00, // ₹20,000
    });
    
    // Need a cycle ID for subsequent tests. We can fetch the auto-resolved cycle ID.
    const snapCard = await loadSnapshot(handles, workspaceId);
    const cycleId = snapCard.billingCycles[0]!.id;
    


    // 3. CLAIMS
    const rahul = await createPerson(handles, { workspaceId }, { name: "Rahul" });
    await applyOpeningClaim(handles, { workspaceId }, {
      commandId: "cmd-open-rec",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: rahul.id,
      direction: "they_owe_user",
      amountPaise: 10_000_00, // ₹10,000
    });
    const claimReceivable = "cmd-open-rec_claim";

    await applyOpeningClaim(handles, { workspaceId }, {
      commandId: "cmd-open-pay",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: rahul.id,
      direction: "user_owes_them",
      amountPaise: 4_000_00, // ₹4,000
    });
    const claimPayable = "cmd-open-pay_claim";

    // 4. EARMARK
    await applyOpeningReservation(handles, { workspaceId }, {
      commandId: "cmd-open-res",
      occurredOn: "2026-08-05",
      capturedAt,
      sourceAccountId: hdfcId,
      cardId: card.id,
      billingCycleId: cycleId,
      amountPaise: 5_000_00, // ₹5,000
    });

    // 5. OPENING CONSERVATION ASSERTIONS
    const snap1 = await loadSnapshot(handles, workspaceId);
    
    const expense = snap1.postings.filter(p => p.pnl === "expense").reduce((acc, p) => acc + p.amountPaise, 0);
    const income = snap1.postings.filter(p => p.pnl?.startsWith("income")).reduce((acc, p) => acc + p.amountPaise, 0);
    expect(expense).toBe(0);
    expect(income).toBe(0);
    expect(snap1.settlementAllocations.length).toBe(0);

    const sts = evaluateSafeToSpend(snap1, "2026-08-11" as IsoDate);
    const bank = snap1.accounts.find(a => a.id === hdfcId);
    expect(bank?.balancePaise).toBe(50_000_00);
    expect(sts.reservedTotal).toBe(5_000_00);
    expect(sts.availableLiquid).toBe(45_000_00);

    const cDetail = await cardDetail(handles, workspaceId, card.id, "2026-08-11" as IsoDate);
    expect(cDetail.outstandingPaise).toBe(20_000_00);
    expect(cDetail.cycles[0]!.statementRemainingPaise).toBe(20_000_00);

    const rDetail = await personDetail(handles, workspaceId, rahul.id);
    expect(rDetail.theyOwePaise).toBe(10_000_00);
    expect(rDetail.youOwePaise).toBe(4_000_00);
    const recClaim = rDetail.claims.find(c => c.id === claimReceivable);
    const payClaim = rDetail.claims.find(c => c.id === claimPayable);
    expect(recClaim?.openAmountPaise).toBe(10_000_00);
    expect(payClaim?.openAmountPaise).toBe(4_000_00);

    // 6. PAY CARD
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
    const sts2 = evaluateSafeToSpend(snap2, "2026-08-23" as IsoDate);
    const bank2 = snap2.accounts.find(a => a.id === hdfcId);
    expect(bank2?.balancePaise).toBe(30_000_00);
    expect(sts2.reservedTotal).toBe(0);

    const cDetail2 = await cardDetail(handles, workspaceId, card.id, "2026-08-23" as IsoDate);
    expect(cDetail2.outstandingPaise).toBe(0);
    expect(cDetail2.cycles[0]!.statementRemainingPaise).toBe(0);

    // 7. RECEIVE CLAIM
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
    const bank3 = snap3.accounts.find(a => a.id === hdfcId);
    expect(bank3?.balancePaise).toBe(40_000_00);
    const rDetail2 = await personDetail(handles, workspaceId, rahul.id);
    expect(rDetail2.claims.find(c => c.id === claimReceivable)?.openAmountPaise).toBe(0);

    // 8. PAY CLAIM
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
    const bank4 = snap4.accounts.find(a => a.id === hdfcId);
    expect(bank4?.balancePaise).toBe(36_000_00);
    const rDetail3 = await personDetail(handles, workspaceId, rahul.id);
    expect(rDetail3.claims.find(c => c.id === claimPayable)?.openAmountPaise).toBe(0);
  });
});
