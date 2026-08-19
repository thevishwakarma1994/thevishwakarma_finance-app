import { describe, it, expect, beforeEach } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { accountAvailability } from "../../src/domain/engine/liquidity.js";
import { applyOpeningCard, correctOpeningCard } from "../../src/app/openingCard.js";
import { applyOpeningClaim } from "../../src/app/openingClaim.js";
import { applyOpeningReservation, correctOpeningReservation } from "../../src/app/openingReservation.js";
import { anyDb, tables } from "../../src/db/exec.js";
import { eq } from "drizzle-orm";
import { createCard } from "../../src/app/cards.js";
import { createPerson } from "../../src/app/people.js";

describe("Phase 16A Final Scenario", () => {
  let handles: SqliteHandles;
  let workspaceId: string;
  let context: { workspaceId: string; asOf: string };
  let accountId: string;
  let cardId: string;
  let cycleId: string;
  let personId: string;
  let t: ReturnType<typeof tables>;
  let db: ReturnType<typeof anyDb>;

  beforeEach(async () => {
    handles = openMemoryDatabase();
    await applyMigrations(handles);
    workspaceId = await getSoleWorkspaceId(handles);
    context = { workspaceId, asOf: "2026-08-19" };

    t = tables(handles);
    db = anyDb(handles);

    // Get default bank account
    const accounts = await db.select().from(t.accounts).where(eq(t.accounts.workspaceId, workspaceId));
    accountId = accounts[0].id;
    
    // Add 50k to account directly for test base state
    await db.insert(t.financialEvents).values({
      id: "base_funding", workspaceId, meaning: "income", occurredOn: "2026-08-19",
      capturedAt: "2026-08-19T00:00:00Z", amountPaise: 5000000, accountId, merchant: "Seed"
    });
    await db.insert(t.postings).values({
      id: "base_funding_p1", workspaceId, eventId: "base_funding", amountPaise: 5000000,
      accountId, pnl: null
    });
    await db.insert(t.postings).values({
      id: "base_funding_p2", workspaceId, eventId: "base_funding", amountPaise: 5000000,
      pnl: "income_salary"
    });

    // Create Card
    const cardRes = await createCard(handles, context, { displayName: "Test Card", issuer: "Test", mask: "1234", statementDay: 1, dueDaysAfterStatement: 20 });
    cardId = cardRes.id;
    
    // Manually create a billing cycle
    cycleId = "cycle1";
    await db.insert(t.billingCycles).values({
      id: cycleId, workspaceId, creditCardId: cardId,
      expectedStatementOn: "2026-08-01", expectedDueOn: "2026-08-21",
      purchaseWindowStart: "2026-07-01", purchaseWindowEnd: "2026-07-31",
      status: "open", ruleSnapshot: JSON.stringify({ statementDay: 1, dueDaysAfterStatement: 20 })
    });

    // Create Person
    const personRes = await createPerson(handles, context, { name: "Test Person" });
    personId = personRes.id;
  });

  it("executes the full ₹50k, ₹20k, ₹10k, ₹4k, ₹5k opening workflow cleanly", async () => {
    // 2. Card Opening Debt = 20,000 (initially 25k mistake)
    await applyOpeningCard(handles, context, {
      commandId: "c1", creditCardId: cardId, billingCycleId: cycleId,
      amountPaise: 2500000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });
    
    await correctOpeningCard(handles, context, {
      commandId: "c2", creditCardId: cardId, billingCycleId: cycleId,
      targetAmountPaise: 2000000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });

    // 3. Receivable = 10,000
    await applyOpeningClaim(handles, context, {
      commandId: "c3", personId, direction: "they_owe_user",
      amountPaise: 1000000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });

    // 4. Payable = 4,000
    await applyOpeningClaim(handles, context, {
      commandId: "c4", personId, direction: "user_owes_them",
      amountPaise: 400000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });

    // 5. Earmarked Card Money = 5,000 (initially 7k mistake)
    await applyOpeningReservation(handles, context, {
      commandId: "c5", sourceAccountId: accountId, billingCycleId: cycleId,
      amountPaise: 700000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });

    const snapshotTemp = await loadSnapshot(handles, workspaceId);
    const reservationId = snapshotTemp.reservations.find(r => r.originatingEventId === `c5`)!.id;

    await correctOpeningReservation(handles, context, {
      commandId: "c6", reservationId, targetAmountPaise: 500000,
      occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });

    const snapshot = await loadSnapshot(handles, workspaceId);

    // bank ledger = 50,000
    const account = snapshot.accounts.find(a => a.id === accountId);
    expect(account!.balancePaise).toBe(5000000);
    
    // reserved = 5,000
    const activeRes = snapshot.reservations.find(r => r.status === "active");
    expect(activeRes?.amountOriginalPaise).toBe(500000);
    
    // available = 45,000
    const availability = accountAvailability(snapshot, accountId);
    expect(availability.availablePaise).toBe(4500000);

    // card ledgerRemaining = 20,000
    const cycle = snapshot.billingCycles.find(c => c.id === cycleId);
    expect(cycle!.ledgerRemainingPaise).toBe(2000000);

    // receivable = 10,000, payable = 4,000
    const receivable = snapshot.claims.find(c => c.direction === "they_owe_user");
    const payable = snapshot.claims.find(c => c.direction === "user_owes_them");
    expect(receivable?.openAmountPaise).toBe(1000000);
    expect(payable?.openAmountPaise).toBe(400000);

    // No fake income/expense: Checked by absence of PNL postings
    // (except the 50k seed which has income_salary)
    expect(snapshot.postings.filter(p => p.eventId !== "base_funding" && p.pnl !== null).length).toBe(0);
  });
  
  it("idempotency check works", async () => {
    // Exact same payload returns ok
    await applyOpeningCard(handles, context, {
      commandId: "c1", creditCardId: cardId, billingCycleId: cycleId,
      amountPaise: 2500000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });
    
    const res = await applyOpeningCard(handles, context, {
      commandId: "c1", creditCardId: cardId, billingCycleId: cycleId,
      amountPaise: 2500000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });
    expect(res.eventId).toBe("c1");
    
    // Different payload fails
    await expect(applyOpeningCard(handles, context, {
      commandId: "c1", creditCardId: cardId, billingCycleId: cycleId,
      amountPaise: 2600000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects corrections when subsequent normal activity exists", async () => {
    // 1. Apply base opening
    await applyOpeningCard(handles, context, {
      commandId: "c10", creditCardId: cardId, billingCycleId: cycleId,
      amountPaise: 2500000, occurredOn: "2026-08-19", capturedAt: new Date().toISOString()
    });

    // 2. Normal card spend activity
    await db.insert(t.financialEvents).values({
      id: "normal_spend", workspaceId, meaning: "spend_card", occurredOn: "2026-08-20",
      capturedAt: new Date().toISOString(), amountPaise: 100000, creditCardId: cardId, billingCycleId: cycleId
    });

    // 3. Correction should be locked
    await expect(correctOpeningCard(handles, context, {
      commandId: "c11", creditCardId: cardId, billingCycleId: cycleId,
      targetAmountPaise: 2000000, occurredOn: "2026-08-21", capturedAt: new Date().toISOString()
    })).rejects.toThrow("Cannot correct opening position after normal lifecycle activity has begun");
  });
});
