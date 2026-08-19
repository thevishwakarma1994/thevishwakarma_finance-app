import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { personDetail } from "../../src/db/reads.js";

import { applyOpening } from "../../src/app/applyOpening.js";
import { applyOpeningCard, correctOpeningCard } from "../../src/app/openingCard.js";
import { applyOpeningClaim, correctOpeningClaim } from "../../src/app/openingClaim.js";
import { applyOpeningReservation } from "../../src/app/openingReservation.js";
import { createCard } from "../../src/app/cards.js";
import { createPerson } from "../../src/app/people.js";
import { payCard } from "../../src/app/payCard.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";
import { paySettlement } from "../../src/app/paySettlement.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  if (!hdfc || !grocery) throw new Error("Expected seeded HDFC and Grocery");

  // Legacy bank opening (already existed before Phase 16)
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 100_000_00, // ₹1,00,000
    commit: true,
  });

  const card = await createCard(handles, { workspaceId }, {
    displayName: "Amex",
    issuer: "Amex",
    mask: "1001",
    statementDay: 10,
    dueDaysAfterStatement: 20,
    defaultPaymentAccountId: hdfc.id,
  });

  const rahul = await createPerson(handles, { workspaceId }, { name: "Rahul" });

  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    groceryId: grocery.id,
    cardId: card.id,
    rahulId: rahul.id,
  };
}

describe("phase 16a lifecycle", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("simulates full onboarding and ensures no fake PnL or cash movement", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    // 1. Set Opening Debt on Card (cycle 2026-08)
    await applyOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open-card",
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: `${ctx.cardId}-2026-08`,
      amountPaise: 20_000_00, // ₹20,000
    });

    // 2. Correct it to ₹25,000
    await correctOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-cor-card",
      occurredOn: "2026-08-06",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: `${ctx.cardId}-2026-08`,
      targetAmountPaise: 25_000_00, // ₹25,000
    });

    // 3. Set Opening Receivable (They owe me)
    await applyOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open-rec",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: ctx.rahulId,
      direction: "they_owe_user",
      amountPaise: 5_000_00, // ₹5,000
    });
    const claimReceivable = "cmd-open-rec_claim";

    // 4. Set Opening Payable (I owe them)
    await applyOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open-pay",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: ctx.rahulId,
      direction: "user_owes_them",
      amountPaise: 2_000_00, // ₹2,000
    });
    const claimPayable = "cmd-open-pay_claim";

    // 5. Correct the payable to ₹1,000
    await correctOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-cor-pay",
      occurredOn: "2026-08-06",
      capturedAt,
      claimId: claimPayable!,
      targetAmountPaise: 1_000_00, // ₹1,000
    });

    // 6. Set Opening Earmark
    await applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open-res",
      occurredOn: "2026-08-05",
      capturedAt,
      sourceAccountId: ctx.hdfcId,
      cardId: ctx.cardId,
      billingCycleId: `${ctx.cardId}-2026-08`,
      amountPaise: 10_000_00, // ₹10,000
    });

    // 7. Verify Snapshots after initialization
    const snap1 = await loadSnapshot(ctx.handles, ctx.workspaceId);
    
    // Check Card Debt = ₹25,000
    const cardOutstanding = snap1.postings.filter(p => p.creditCardId === ctx.cardId).reduce((acc, p) => acc + p.amountPaise, 0);
    expect(cardOutstanding).toBe(25_000_00);

    // Check PnL is absolutely 0!
    const expense = snap1.postings.filter(p => p.pnl === "expense").reduce((acc, p) => acc + p.amountPaise, 0);
    const income = snap1.postings.filter(p => p.pnl?.startsWith("income")).reduce((acc, p) => acc + p.amountPaise, 0);
    expect(expense).toBe(0);
    expect(income).toBe(0);

    // Cash in HDFC should STILL be ₹1,00,000 (from legacy opening)
    const hdfc = snap1.accounts.find(a => a.id === ctx.hdfcId);
    expect(hdfc?.balancePaise).toBe(100_000_00);

    // Claims:
    const rec = snap1.claims.find(c => c.id === claimReceivable);
    expect(rec?.originalAmountPaise).toBe(5_000_00);
    const pay = snap1.claims.find(c => c.id === claimPayable);
    expect(pay?.originalAmountPaise).toBe(2_000_00);

    // 8. Normal operations mixing with opening facts
    // Pay ₹5,000 card bill
    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-pay-card",
      occurredOn: "2026-08-22",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: `${ctx.cardId}-2026-08`,
      accountId: ctx.hdfcId,
      amountPaise: 5_000_00,
      commit: true,
    });

    // They pay me ₹2,000 back
    await receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-rec-settle",
      occurredOn: "2026-08-25",
      capturedAt,
      personId: ctx.rahulId,
      accountId: ctx.hdfcId,
      amountPaise: 2_000_00,
      allocations: [{ claimId: claimReceivable!, amountPaise: 2_000_00 }],
      commit: true,
    });

    // I pay them ₹1,000 back
    await paySettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-pay-settle",
      occurredOn: "2026-08-25",
      capturedAt,
      personId: ctx.rahulId,
      accountId: ctx.hdfcId,
      amountPaise: 1_000_00,
      allocations: [{ claimId: claimPayable!, amountPaise: 1_000_00 }],
      commit: true,
    });

    // 9. Final Verification
    const snap2 = await loadSnapshot(ctx.handles, ctx.workspaceId);
    
    // Card Outstanding = 25000 - 5000 = 20000
    const cardOutstanding2 = snap2.postings.filter(p => p.creditCardId === ctx.cardId).reduce((acc, p) => acc + p.amountPaise, 0);
    expect(cardOutstanding2).toBe(20_000_00);

    // Person Net (Rahul owes me 3000 now)
    const person = await personDetail(ctx.handles, ctx.workspaceId, ctx.rahulId);
    expect(person.netPaise).toBe(3_000_00);
    expect(person.theyOwePaise).toBe(3_000_00);
    expect(person.youOwePaise).toBe(0);

    // HDFC balance = 100000 - 5000 (card) + 2000 (receive) - 1000 (pay) = 96000
    const hdfc2 = snap2.accounts.find(a => a.id === ctx.hdfcId);
    expect(hdfc2?.balancePaise).toBe(96_000_00);

    // PnL should still be exactly 0
    const expense2 = snap2.postings.filter(p => p.pnl === "expense").reduce((acc, p) => acc + p.amountPaise, 0);
    const income2 = snap2.postings.filter(p => p.pnl?.startsWith("income")).reduce((acc, p) => acc + p.amountPaise, 0);
    expect(expense2).toBe(0);
    expect(income2).toBe(0);
  });
});
