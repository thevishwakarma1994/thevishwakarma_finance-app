import { confirmStatement } from "../../src/app/confirmStatement.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { type IsoDate } from "../../src/domain/calendar/isoDate.js";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { createPerson } from "../../src/app/people.js";
import { applyOpeningClaim, correctOpeningClaim } from "../../src/app/openingClaim.js";
import { applyOpeningReservation, correctOpeningReservation } from "../../src/app/openingReservation.js";
import { applyOpeningCard, correctOpeningCard } from "../../src/app/openingCard.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";
import { paySettlement } from "../../src/app/paySettlement.js";
import { payCard } from "../../src/app/payCard.js";
import { createCard } from "../../src/app/cards.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { recordSplit } from "../../src/app/recordSplit.js";
import { cardDetail } from "../../src/db/reads.js";



const capturedAt = "2026-08-16T10:00:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected HDFC");

  // give hdfc 50k
  await applyOpening(handles, { workspaceId }, { accountId: hdfc.id, effectiveOn: "2026-08-01", balancePaise: 50000_00, commit: true });

  const rahul = await createPerson(handles, { workspaceId }, { name: "Rahul" });
  const rahul2 = await createPerson(handles, { workspaceId }, { name: "Rahul2" });

  const card = await createCard(handles, { workspaceId }, {
    displayName: "Amex",
    issuer: "Amex",
    mask: "1001",
    statementDay: 10,
    dueDaysAfterStatement: 20,
    defaultPaymentAccountId: hdfc.id,
  });

  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    rahulId: rahul.id,
    rahul2Id: rahul2.id,
    cardId: card.id,
  };
}

describe("phase 16a correction workflows", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("1. historical claim asOf", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    // Day 1
    await applyOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open",
      occurredOn: "2026-08-01" as IsoDate,
      capturedAt,
      personId: ctx.rahulId,
      direction: "they_owe_user",
      amountPaise: 10_000_00,
    });

    // Day 2 (correct to 0 = void)
    await correctOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-cor-0",
      occurredOn: "2026-08-02" as IsoDate,
      capturedAt,
      claimId: "cmd-open_claim",
      targetAmountPaise: 0,
    });

    // As of Day 1
    const snapDay1 = await loadSnapshot(ctx.handles, ctx.workspaceId, "2026-08-01" as IsoDate);
    const claimDay1 = snapDay1.claims.find(c => c.id === "cmd-open_claim");
    expect(claimDay1?.openAmountPaise).toBe(10_000_00);
    expect(claimDay1?.status).toBe("open");

    // As of Day 2 (current)
    const snapDay2 = await loadSnapshot(ctx.handles, ctx.workspaceId, "2026-08-02" as IsoDate);
    const claimDay2 = snapDay2.claims.find(c => c.id === "cmd-open_claim");
    expect(claimDay2?.openAmountPaise).toBe(0);
    expect(claimDay2?.status).toBe("void");

    // Test correct to 7k
    await applyOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open2",
      occurredOn: "2026-08-01" as IsoDate,
      capturedAt,
      personId: ctx.rahul2Id,
      direction: "they_owe_user",
      amountPaise: 10_000_00,
    });
    await correctOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-cor-7",
      occurredOn: "2026-08-02" as IsoDate,
      capturedAt,
      claimId: "cmd-open2_claim",
      targetAmountPaise: 7_000_00,
    });
    
    const snapDay1b = await loadSnapshot(ctx.handles, ctx.workspaceId, "2026-08-01" as IsoDate);
    expect(snapDay1b.claims.find(c => c.id === "cmd-open2_claim")?.openAmountPaise).toBe(10_000_00);
    expect(snapDay1b.claims.find(c => c.id === "cmd-open2_claim")?.status).toBe("open");

    const snapDay2b = await loadSnapshot(ctx.handles, ctx.workspaceId, "2026-08-02" as IsoDate);
    expect(snapDay2b.claims.find(c => c.id === "cmd-open2_claim")?.openAmountPaise).toBe(7_000_00);
    expect(snapDay2b.claims.find(c => c.id === "cmd-open2_claim")?.status).toBe("open");
  });

  it("2. new card earmark resolved uniqueness", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    await applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-res1",
      occurredOn: "2026-08-05",
      capturedAt,
      sourceAccountId: ctx.hdfcId,
      cardId: ctx.cardId,
      amountPaise: 5_000_00,
    });

    await expect(
      applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-res2",
        occurredOn: "2026-08-05",
        capturedAt,
        sourceAccountId: ctx.hdfcId,
        cardId: ctx.cardId,
        amountPaise: 3_000_00,
      })
    ).rejects.toMatchObject({ code: "already_exists" });

    const snap = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snap.billingCycles).toHaveLength(1);
    expect(snap.reservations).toHaveLength(1);
  });

  it("3. reservation correction chain", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    // Initial 5k
    await applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-res-chain",
      occurredOn: "2026-08-05",
      capturedAt,
      sourceAccountId: ctx.hdfcId,
      cardId: ctx.cardId,
      amountPaise: 5_000_00,
    });
    
    const snap1 = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const resId = snap1.reservations[0]!.id;
    

    // Correct to 3k
    await correctOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-cor-3",
      reservationId: resId,
      occurredOn: "2026-08-06",
      capturedAt,
      targetAmountPaise: 3_000_00,
    });
    const snap2 = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snap2.reservations.find(r => r.id === "cmd-cor-3_res")?.amountOriginalPaise).toBe(3_000_00);
    
    // Correct to 4k
    await correctOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-cor-4",
      reservationId: "cmd-cor-3_res",
      occurredOn: "2026-08-07" as IsoDate,
      capturedAt,
      targetAmountPaise: 4_000_00,
    });
    const snap3 = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snap3.reservations.find(r => r.id === "cmd-cor-4_res")?.amountOriginalPaise).toBe(4_000_00);
    expect(snap3.postings.filter(p => p.pnl)).toHaveLength(0); // no fake pnl

    // Consume with payCard
    await applyOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-c-chain",
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: ctx.cardId,
      amountPaise: 10_000_00,
    });
    
    
    // force cycle creation
    await confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cycleId: snap1.billingCycles[0]!.id,
      actualStatementAmountPaise: 18_000_00,
      actualStatementOn: "2026-08-10",
      actualDueOn: "2026-08-30",
    });
    
    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      accountId: ctx.hdfcId,
      billingCycleId: snap1.billingCycles[0]!.id,
      amountPaise: 10_000_00,
      commit: true,
    });

    // Reject further correction
    await expect(
      correctOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-cor-fail",
        reservationId: "cmd-cor-4_res",
        occurredOn: "2026-08-21",
        capturedAt,
        targetAmountPaise: 5_000_00,
      })
    ).rejects.toMatchObject({ code: "invalid_opening" });
  });

  it("4. card correction lock", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    await applyOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-card",
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: ctx.cardId,
      amountPaise: 20_000_00,
    });
    
    await correctOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-cor-card",
      occurredOn: "2026-08-06",
      capturedAt,
      creditCardId: ctx.cardId,
      billingCycleId: (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]!.id,
      targetAmountPaise: 18_000_00,
    });

    const detail = await cardDetail(ctx.handles, ctx.workspaceId, ctx.cardId, "2026-08-07" as IsoDate);
    expect(detail.outstandingPaise).toBe(18_000_00);

    const snap1 = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snap1.postings.filter(p => p.pnl)).toHaveLength(0); // no fake pnl

    await confirmStatement(ctx.handles, { workspaceId: ctx.workspaceId }, { cycleId: (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]!.id, actualStatementAmountPaise: 18_000_00, actualStatementOn: "2026-08-10", actualDueOn: "2026-08-30" });
    await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: ctx.cardId,
      accountId: ctx.hdfcId,
      billingCycleId: (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]!.id,
      amountPaise: 10_000_00,
      commit: true,
    });

    await expect(
      correctOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-cor-card2",
        occurredOn: "2026-08-21",
        capturedAt,
        creditCardId: ctx.cardId,
        billingCycleId: (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles[0]!.id,
        targetAmountPaise: 15_000_00,
      })
    ).rejects.toMatchObject({ code: "invalid_opening" });
  });

  it("5. claim correction tests", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    // A
    await applyOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "c-rec",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: ctx.rahulId,
      direction: "they_owe_user",
      amountPaise: 10_000_00,
    });
    await correctOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "c-rec-cor",
      occurredOn: "2026-08-06",
      capturedAt,
      claimId: "c-rec_claim",
      targetAmountPaise: 7_000_00,
    });
    let snap = await loadSnapshot(ctx.handles, ctx.workspaceId);
    let claim = snap.claims.find(c => c.id === "c-rec_claim")!;
    expect(claim.originalAmountPaise).toBe(10_000_00);
    expect(claim.openAmountPaise).toBe(7_000_00);

    await receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "c-rec-set",
      occurredOn: "2026-08-07" as IsoDate,
      capturedAt,
      personId: ctx.rahulId,
      accountId: ctx.hdfcId,
      amountPaise: 7_000_00,
      allocations: [{ claimId: "c-rec_claim", amountPaise: 7_000_00 }],
      commit: true,
    });
    snap = await loadSnapshot(ctx.handles, ctx.workspaceId);
    claim = snap.claims.find(c => c.id === "c-rec_claim")!;
    expect(claim.openAmountPaise).toBe(0);

    // B
    await applyOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "c-pay",
      occurredOn: "2026-08-05",
      capturedAt,
      personId: ctx.rahulId,
      direction: "user_owes_them",
      amountPaise: 10_000_00,
    });
    await correctOpeningClaim(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "c-pay-cor",
      occurredOn: "2026-08-06",
      capturedAt,
      claimId: "c-pay_claim",
      targetAmountPaise: 0,
    });
    snap = await loadSnapshot(ctx.handles, ctx.workspaceId);
    claim = snap.claims.find(c => c.id === "c-pay_claim")!;
    expect(claim.status).toBe("void");
    expect(claim.openAmountPaise).toBe(0);
    
    await expect(
      paySettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "c-pay-set",
        occurredOn: "2026-08-07" as IsoDate,
        capturedAt,
        personId: ctx.rahulId,
        accountId: ctx.hdfcId,
        amountPaise: 1_000_00,
        allocations: [{ claimId: "c-pay_claim", amountPaise: 1_000_00 }],
        commit: true,
      })
    ).rejects.toMatchObject({ code: "invalid_allocation" }); // cannot settle voided claim
  });

  it("6. rejects base opening after real card spend or split", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const groceryId = (await loadSnapshot(ctx.handles, ctx.workspaceId)).categories.find(
      (category) => category.name === "Grocery",
    )!.id;

    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: ctx.cardId,
      allocations: [{ categoryId: groceryId, amountPaise: 1_000_00 }],
      commit: true,
    });

    await expect(
      applyOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-open-after-spend",
        occurredOn: "2026-08-05",
        capturedAt,
        creditCardId: ctx.cardId,
        amountPaise: 20_000_00,
      }),
    ).rejects.toMatchObject({ code: "invalid_opening" });

    const otherCard = await createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "Visa",
      issuer: "Visa",
      mask: "2002",
      statementDay: 10,
      dueDaysAfterStatement: 20,
      defaultPaymentAccountId: ctx.hdfcId,
    });
    await recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      amountPaise: 2_000_00,
      source: { type: "card", creditCardId: otherCard.id },
      userSharePaise: 1_000_00,
      personShares: [{ personId: ctx.rahulId, amountPaise: 1_000_00 }],
      allocations: [{ categoryId: groceryId, amountPaise: 1_000_00 }],
      commit: true,
    });

    await expect(
      applyOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-open-after-split",
        occurredOn: "2026-08-05",
        capturedAt,
        creditCardId: otherCard.id,
        amountPaise: 20_000_00,
      }),
    ).rejects.toMatchObject({ code: "invalid_opening" });
  });

  it("7. rejects a second base opening on another billing cycle of the same card", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);

    await applyOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-open-cycle-a",
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: ctx.cardId,
      amountPaise: 20_000_00,
    });
    const snapA = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapA.billingCycles).toHaveLength(1);
    const cycleAId = snapA.billingCycles[0]!.id;

    await applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "cmd-res-cycle-b",
      occurredOn: "2026-09-15",
      capturedAt,
      sourceAccountId: ctx.hdfcId,
      cardId: ctx.cardId,
      amountPaise: 1_000_00,
    });
    const snapB = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const cycleB = snapB.billingCycles.find((cycle) => cycle.id !== cycleAId);
    expect(cycleB).toBeDefined();

    await expect(
      applyOpeningCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
        commandId: "cmd-open-cycle-b",
        occurredOn: "2026-09-15",
        capturedAt,
        creditCardId: ctx.cardId,
        billingCycleId: cycleB!.id,
        amountPaise: 5_000_00,
      }),
    ).rejects.toMatchObject({ code: "already_exists" });

    const snapFinal = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(
      snapFinal.events.filter(
        (event) =>
          event.meaning === "apply_opening_card_position" && event.creditCardId === ctx.cardId,
      ),
    ).toHaveLength(1);
  });
});
