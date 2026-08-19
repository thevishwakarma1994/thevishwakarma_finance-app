import { confirmStatement } from "../../src/app/confirmStatement.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations } from "../../src/db/migrate.js";
import { createPerson } from "../../src/app/people.js";
import { createCard } from "../../src/app/cards.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { applyOpeningClaim, correctOpeningClaim } from "../../src/app/openingClaim.js";
import { applyOpeningCard, correctOpeningCard } from "../../src/app/openingCard.js";
import { applyOpeningReservation, correctOpeningReservation } from "../../src/app/openingReservation.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

describe("workspace isolation & idempotency matrix", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("rejects cross-workspace command ID reuse with generic idempotency_conflict", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);

    const ws1 = "ws1";
    const ws2 = "ws2";

    handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run(ws1, "Workspace 1");
    handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run(ws2, "Workspace 2");

        handles.sqlite.prepare("INSERT INTO accounts (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("acc1", ws1, "cash", "HDFC1", "active", "2026-08-01");
    handles.sqlite.prepare("INSERT INTO accounts (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("acc2", ws2, "cash", "HDFC2", "active", "2026-08-01");
    await applyOpening(handles, { workspaceId: ws1 }, { accountId: "acc1", effectiveOn: "2026-08-01", balancePaise: 5000000, commit: true });
    await applyOpening(handles, { workspaceId: ws2 }, { accountId: "acc2", effectiveOn: "2026-08-01", balancePaise: 5000000, commit: true });

    const rahul1 = await createPerson(handles, { workspaceId: ws1 }, { name: "Rahul1" });
    const rahul2 = await createPerson(handles, { workspaceId: ws2 }, { name: "Rahul2" });

    const card1 = await createCard(handles, { workspaceId: ws1 }, { displayName: "C1", issuer: "Amex", mask: "1111", statementDay: 1, dueDaysAfterStatement: 20, defaultPaymentAccountId: "acc1" });
    const card2 = await createCard(handles, { workspaceId: ws2 }, { displayName: "C2", issuer: "Amex", mask: "2222", statementDay: 1, dueDaysAfterStatement: 20, defaultPaymentAccountId: "acc2" });

    // 1. applyOpeningClaim
    await applyOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "cmd-claim", occurredOn: "2026-08-05", capturedAt, personId: rahul1.id, direction: "they_owe_user", amountPaise: 500_00 });
    await expect(
      applyOpeningClaim(handles, { workspaceId: ws2 }, { commandId: "cmd-claim", occurredOn: "2026-08-05", capturedAt, personId: rahul2.id, direction: "they_owe_user", amountPaise: 500_00 })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    // 2. correctOpeningClaim
    await correctOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "cmd-cor-claim", occurredOn: "2026-08-06", capturedAt, claimId: "cmd-claim_claim", targetAmountPaise: 300_00 });
    // Make sure the claim exists in ws2
    await applyOpeningClaim(handles, { workspaceId: ws2 }, { commandId: "cmd-claim2", occurredOn: "2026-08-05", capturedAt, personId: rahul2.id, direction: "they_owe_user", amountPaise: 500_00 });
    await expect(
      correctOpeningClaim(handles, { workspaceId: ws2 }, { commandId: "cmd-cor-claim", occurredOn: "2026-08-06", capturedAt, claimId: "cmd-claim2_claim", targetAmountPaise: 300_00 })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    // 3. applyOpeningCard
    await applyOpeningCard(handles, { workspaceId: ws1 }, { commandId: "cmd-card", occurredOn: "2026-08-05", capturedAt, creditCardId: card1.id, amountPaise: 1000_00 });
    await expect(
      applyOpeningCard(handles, { workspaceId: ws2 }, { commandId: "cmd-card", occurredOn: "2026-08-05", capturedAt, creditCardId: card2.id, amountPaise: 1000_00 })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    // 4. applyOpeningReservation
    await applyOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "cmd-res", occurredOn: "2026-08-05", capturedAt, sourceAccountId: "acc1", cardId: card1.id, amountPaise: 500_00 });
    await expect(
      applyOpeningReservation(handles, { workspaceId: ws2 }, { commandId: "cmd-res", occurredOn: "2026-08-05", capturedAt, sourceAccountId: "acc2", cardId: card2.id, amountPaise: 500_00 })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    await applyOpeningReservation(handles, { workspaceId: ws2 }, { commandId: "cmd-res2", occurredOn: "2026-08-05", capturedAt, sourceAccountId: "acc2", cardId: card2.id, amountPaise: 500_00 });
    // 5. correctOpeningReservation
    await correctOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "cmd-cor-res", occurredOn: "2026-08-06", capturedAt, reservationId: "cmd-res_res", targetAmountPaise: 200_00 });
    await expect(
      correctOpeningReservation(handles, { workspaceId: ws2 }, { commandId: "cmd-cor-res", occurredOn: "2026-08-06", capturedAt, reservationId: "cmd-res2_res", targetAmountPaise: 200_00 })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("handles same-workspace idempotency properly", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);
    const ws1 = "ws1";
    handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run(ws1, "Workspace 1");
    handles.sqlite.prepare("INSERT INTO accounts (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("acc1", ws1, "cash", "HDFC1", "active", "2026-08-01");
    const card1 = await createCard(handles, { workspaceId: ws1 }, { displayName: "C1", issuer: "Amex", mask: "1111", statementDay: 1, dueDaysAfterStatement: 20, defaultPaymentAccountId: "acc1" });

    // applyOpeningCard exactly same payload -> success
    await applyOpeningCard(handles, { workspaceId: ws1 }, { commandId: "idem-card", occurredOn: "2026-08-05", capturedAt, creditCardId: card1.id, amountPaise: 1000_00 });
    await applyOpeningCard(handles, { workspaceId: ws1 }, { commandId: "idem-card", occurredOn: "2026-08-05", capturedAt, creditCardId: card1.id, amountPaise: 1000_00 }); // idempoten

    // different payload -> conflic
    await expect(
      applyOpeningCard(handles, { workspaceId: ws1 }, { commandId: "idem-card", occurredOn: "2026-08-05", capturedAt, creditCardId: card1.id, amountPaise: 2000_00 })
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});


describe("idempotency matrix (all six)", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("same payload is idempotent, different payload throws conflict", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);
    const ws1 = "ws1";
    handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run(ws1, "Workspace 1");
    handles.sqlite.prepare("INSERT INTO accounts (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("acc1", ws1, "cash", "HDFC1", "active", "2026-08-01");
    await applyOpening(handles, { workspaceId: ws1 }, { accountId: "acc1", effectiveOn: "2026-08-01", balancePaise: 5000000, commit: true });
    const card1 = await createCard(handles, { workspaceId: ws1 }, { displayName: "C1", issuer: "Amex", mask: "1111", statementDay: 1, dueDaysAfterStatement: 20, defaultPaymentAccountId: "acc1" });
    const rahul = await createPerson(handles, { workspaceId: ws1 }, { name: "Rahul1" });

    // 1. applyOpeningCard
    await applyOpeningCard(handles, { workspaceId: ws1 }, { commandId: "c1", occurredOn: "2026-08-05", capturedAt, creditCardId: card1.id, amountPaise: 1000 });
    await applyOpeningCard(handles, { workspaceId: ws1 }, { commandId: "c1", occurredOn: "2026-08-05", capturedAt, creditCardId: card1.id, amountPaise: 1000 });
    await expect(applyOpeningCard(handles, { workspaceId: ws1 }, { commandId: "c1", occurredOn: "2026-08-05", capturedAt, creditCardId: card1.id, amountPaise: 2000 })).rejects.toMatchObject({ code: "idempotency_conflict" });

    // 2. correctOpeningCard
    await confirmStatement(handles, { workspaceId: ws1 }, { cycleId: (await loadSnapshot(handles, ws1)).billingCycles[0]!.id, actualStatementAmountPaise: 1000, actualStatementOn: "2026-08-10", actualDueOn: "2026-08-30" });
    await correctOpeningCard(handles, { workspaceId: ws1 }, { commandId: "c2", occurredOn: "2026-08-06", capturedAt, creditCardId: card1.id, billingCycleId: (await loadSnapshot(handles, ws1)).billingCycles[0]!.id, targetAmountPaise: 500 });
    await correctOpeningCard(handles, { workspaceId: ws1 }, { commandId: "c2", occurredOn: "2026-08-06", capturedAt, creditCardId: card1.id, billingCycleId: (await loadSnapshot(handles, ws1)).billingCycles[0]!.id, targetAmountPaise: 500 });
    await expect(correctOpeningCard(handles, { workspaceId: ws1 }, { commandId: "c2", occurredOn: "2026-08-06", capturedAt, creditCardId: card1.id, billingCycleId: (await loadSnapshot(handles, ws1)).billingCycles[0]!.id, targetAmountPaise: 600 })).rejects.toMatchObject({ code: "idempotency_conflict" });
    // 3. applyOpeningClaim
    await applyOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "c3", occurredOn: "2026-08-05", capturedAt, personId: rahul.id, direction: "they_owe_user", amountPaise: 1000 });
    await applyOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "c3", occurredOn: "2026-08-05", capturedAt, personId: rahul.id, direction: "they_owe_user", amountPaise: 1000 });
    await expect(applyOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "c3", occurredOn: "2026-08-05", capturedAt, personId: rahul.id, direction: "they_owe_user", amountPaise: 2000 })).rejects.toMatchObject({ code: "idempotency_conflict" });

    // 4. correctOpeningClaim
    await correctOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "c4", occurredOn: "2026-08-06", capturedAt, claimId: "c3_claim", targetAmountPaise: 500 });
    await correctOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "c4", occurredOn: "2026-08-06", capturedAt, claimId: "c3_claim", targetAmountPaise: 500 });
    await expect(correctOpeningClaim(handles, { workspaceId: ws1 }, { commandId: "c4", occurredOn: "2026-08-06", capturedAt, claimId: "c3_claim", targetAmountPaise: 600 })).rejects.toMatchObject({ code: "idempotency_conflict" });

    // 5. applyOpeningReservation
    await applyOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "c5", occurredOn: "2026-08-05", capturedAt, sourceAccountId: "acc1", cardId: card1.id, amountPaise: 1000 });
    await applyOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "c5", occurredOn: "2026-08-05", capturedAt, sourceAccountId: "acc1", cardId: card1.id, amountPaise: 1000 });
    await expect(applyOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "c5", occurredOn: "2026-08-05", capturedAt, sourceAccountId: "acc1", cardId: card1.id, amountPaise: 2000 })).rejects.toMatchObject({ code: "idempotency_conflict" });

    // 6. correctOpeningReservation
    await correctOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "c6", occurredOn: "2026-08-06", capturedAt, reservationId: "c5_res", targetAmountPaise: 500 });
    await correctOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "c6", occurredOn: "2026-08-06", capturedAt, reservationId: "c5_res", targetAmountPaise: 500 });
    await expect(correctOpeningReservation(handles, { workspaceId: ws1 }, { commandId: "c6", occurredOn: "2026-08-06", capturedAt, reservationId: "c5_res", targetAmountPaise: 600 })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
