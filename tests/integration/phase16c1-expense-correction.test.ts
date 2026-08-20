import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import {
  currentMonthSpendFromSnapshot,
  home,
  listActivity,
  money,
  monthReview,
  publicTransactionDetail,
} from "../../src/db/reads.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { createAccount } from "../../src/app/accounts.js";
import { createCategory } from "../../src/app/categories.js";
import { createCard } from "../../src/app/cards.js";
import { createPerson } from "../../src/app/people.js";
import { recordExpense } from "../../src/app/recordExpense.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { transferMoney } from "../../src/app/transferMoney.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { payCard } from "../../src/app/payCard.js";
import { recordSplit } from "../../src/app/recordSplit.js";
import { lendMoney } from "../../src/app/lendMoney.js";
import { borrowMoney } from "../../src/app/borrowMoney.js";
import { receiveSettlement } from "../../src/app/receiveSettlement.js";
import { paySettlement } from "../../src/app/paySettlement.js";
import { createOneOffObligation } from "../../src/app/obligations.js";
import { recordObligationPayment } from "../../src/app/recordObligationPayment.js";
import { applyOpeningReservation } from "../../src/app/openingReservation.js";
import { applySalaryPolicy } from "../../src/app/salaryPolicy.js";
import { correctExpenseTransaction } from "../../src/app/correctExpense.js";
import { accountAvailability } from "../../src/domain/engine/liquidity.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { newId } from "../../src/domain/ids.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import type { VerifyIdToken } from "../../src/api/auth/guard.js";

const capturedAt = "2026-08-20T10:00:00.000Z";
const occurredOn = "2026-08-01";

const verifyIdToken: VerifyIdToken = async (token) => {
  if (token === "invalid") throw new Error("rejected");
  return { uid: token, email: `${token}@example.test`, displayName: token };
};

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  const household = snapshot.categories.find((category) => category.name === "Household");
  if (!hdfc || !grocery || !household) throw new Error("expected seed");
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: occurredOn,
    balancePaise: 10_000_00,
    commit: true,
  });
  const eating = await createCategory(handles, { workspaceId }, { name: "Eating Out" });
  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    groceryId: grocery.id,
    householdId: household.id,
    eatingId: eating.id,
  };
}

async function spend(
  ctx: Awaited<ReturnType<typeof setup>>,
  amountPaise: number,
  extras: { accountId?: string; categoryId?: string; merchant?: string | null; notes?: string | null } = {},
) {
  return recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
    occurredOn,
    capturedAt,
    accountId: extras.accountId ?? ctx.hdfcId,
    allocations: [{ categoryId: extras.categoryId ?? ctx.eatingId, amountPaise }],
    merchant: extras.merchant,
    notes: extras.notes,
    commit: true,
  });
}

function correctionBody(
  ctx: Awaited<ReturnType<typeof setup>>,
  targetEventId: string,
  amountPaise: number,
  extras: {
    commandId?: string;
    rootEventId?: string;
    sourceAccountId?: string;
    categoryId?: string;
    allocations?: { categoryId: string; amountPaise: number }[];
    merchant?: string | null;
    notes?: string | null;
    reason?: string | null;
    occurredOn?: string;
    commit?: boolean;
  } = {},
) {
  return {
    commandId: extras.commandId ?? newId(),
    rootEventId: extras.rootEventId ?? targetEventId,
    targetEventId,
    amountPaise,
    sourceAccountId: extras.sourceAccountId ?? ctx.hdfcId,
    occurredOn: extras.occurredOn ?? occurredOn,
    allocations: extras.allocations ?? [{ categoryId: extras.categoryId ?? ctx.eatingId, amountPaise }],
    merchant: extras.merchant,
    notes: extras.notes,
    reason: extras.reason,
    capturedAt,
    commit: extras.commit ?? true,
  };
}

describe("phase 16c1 expense correction", () => {
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
    handles = undefined;
  });

  it("corrects 1850 to 1580 with production reads, one Activity row, and STS", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx, 1_850_00);
    const result = await correctExpenseTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 1_580_00),
    );
    expect(result.committed).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.corrected).toBe(true);
    expect(result.correctionCount).toBe(1);
    expect(result.effectiveEventId).toBe(result.replacementEventId);

    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const hdfc = snapshot.accounts.find((account) => account.id === ctx.hdfcId);
    expect(hdfc?.balancePaise).toBe(8_420_00);
    expect(currentMonthSpendFromSnapshot(snapshot, isoDate("2026-08-20")).spentPaise).toBe(1_580_00);
    const review = await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"));
    const eating = review.categories.find((row) => row.categoryId === ctx.eatingId);
    expect(eating?.spentPaise).toBe(1_580_00);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity.filter((event) => event.meaning === "spend_account")).toHaveLength(1);
    expect(activity[0]?.amountPaise).toBe(1_580_00);
    expect(activity[0]?.corrected).toBe(true);
    expect(activity[0]?.correctionCount).toBe(1);
    expect(activity.some((event) => event.meaning === "transaction_reversal")).toBe(false);
    const moneyView = await money(ctx.handles, ctx.workspaceId);
    expect(moneyView.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(8_420_00);
    expect(moneyView.month.spentPaise).toBe(1_580_00);
    const homeView = await home(ctx.handles, ctx.workspaceId);
    expect(homeView.accounts.find((account) => account.accountId === ctx.hdfcId)?.balancePaise).toBe(8_420_00);
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.accounts.find((account) => account.accountId === ctx.hdfcId)?.balancePaise).toBe(8_420_00);
    expect(accountAvailability(snapshot, ctx.hdfcId).availablePaise).toBe(8_420_00);

    const detail = await publicTransactionDetail(ctx.handles, ctx.workspaceId, recorded.eventId!);
    expect(detail?.amountPaise).toBe(1_580_00);
    expect(detail?.history).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toMatch(/reversal_of_event_id|transaction_corrections|posting/i);
  });

  it("supports a second sequential correction and rejects a stale target", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx, 1_850_00);
    const first = await correctExpenseTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 1_580_00, { commandId: "first" }),
    );
    const second = await correctExpenseTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, first.replacementEventId!, 1_620_00, {
        commandId: "second",
        rootEventId: first.rootEventId,
      }),
    );
    expect(second.correctionCount).toBe(2);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.amountPaise).toBe(1_620_00);
    expect(activity[0]?.corrected).toBe(true);
    await expect(
      correctExpenseTransaction(
        ctx.handles,
        { workspaceId: ctx.workspaceId },
        correctionBody(ctx, recorded.eventId!, 1_500_00, {
          commandId: "stale",
          rootEventId: first.rootEventId,
        }),
      ),
    ).rejects.toMatchObject({ code: "stale_correction_target" });
  });

  it("moves a Grocery spend from HDFC to PNB", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 5_000_00,
      openingEffectiveOn: occurredOn,
    });
    const recorded = await spend(ctx, 2_000_00, { categoryId: ctx.groceryId });
    await correctExpenseTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 2_000_00, {
        sourceAccountId: pnb.id,
        categoryId: ctx.groceryId,
      }),
    );
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(10_000_00);
    expect(snapshot.accounts.find((account) => account.id === pnb.id)?.balancePaise).toBe(3_000_00);
    expect(currentMonthSpendFromSnapshot(snapshot, isoDate("2026-08-20")).spentPaise).toBe(2_000_00);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.corrected).toBe(true);
    expect(activity[0]?.accountName).toBe("PNB");
  });

  it("rejects a source change into reserved money without partial artifacts", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 5_000_00,
      openingEffectiveOn: occurredOn,
    });
    const card = await createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: pnb.id,
    });
    await applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "res-pnb",
      occurredOn,
      capturedAt,
      sourceAccountId: pnb.id,
      cardId: card.id,
      amountPaise: 4_000_00,
    });
    const recorded = await spend(ctx, 2_000_00, { categoryId: ctx.groceryId });
    const before = await loadSnapshot(ctx.handles, ctx.workspaceId);
    await expect(
      correctExpenseTransaction(
        ctx.handles,
        { workspaceId: ctx.workspaceId },
        correctionBody(ctx, recorded.eventId!, 2_000_00, {
          sourceAccountId: pnb.id,
          categoryId: ctx.groceryId,
        }),
      ),
    ).rejects.toMatchObject({ code: "correction_would_use_reserved_money" });
    const after = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.transactionCorrections).toHaveLength(0);
    expect(after.events.filter((event) => event.meaning === "transaction_reversal")).toHaveLength(0);
    expect(after.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(
      before.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise,
    );
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity.filter((event) => event.meaning === "spend_account")).toHaveLength(1);
    expect(activity[0]?.id).toBe(recorded.eventId);
    expect(activity[0]?.corrected).toBe(false);
  });

  it("replays an exact retry and conflicts on material changes", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx, 1_850_00, { merchant: "Cafe", notes: "lunch" });
    const body = correctionBody(ctx, recorded.eventId!, 1_580_00, {
      commandId: "idem-1",
      merchant: "Cafe",
      notes: "lunch",
      reason: "typo",
    });
    const first = await correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, body);
    const replay = await correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, body);
    expect(replay.replayed).toBe(true);
    expect(replay.correctionId).toBe(first.correctionId);
    expect(replay.reversalEventId).toBe(first.reversalEventId);
    expect(replay.replacementEventId).toBe(first.replacementEventId);

    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 5_000_00,
      openingEffectiveOn: occurredOn,
    });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, amountPaise: 1_500_00, allocations: [{ categoryId: ctx.eatingId, amountPaise: 1_500_00 }] }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, allocations: [{ categoryId: ctx.groceryId, amountPaise: 1_580_00 }] }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, sourceAccountId: pnb.id }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, merchant: "Bakery" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, notes: "dinner" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, reason: "other" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, occurredOn: "2026-08-02" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, targetEventId: newId() }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects cross-workspace reuse of the same commandId", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx, 500_00);
    await correctExpenseTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 400_00, { commandId: "shared-cmd" }),
    );
    ctx.handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run("ws2", "Other");
    ctx.handles.sqlite.prepare(
      "INSERT INTO accounts (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("acc-ws2", "ws2", "bank", "HDFC", "active", "2026-08-01");
    ctx.handles.sqlite.prepare(
      "INSERT INTO categories (id, workspace_id, parent_id, name, archived_at) VALUES (?, ?, ?, ?, ?)",
    ).run("cat-ws2", "ws2", null, "Grocery", null);
    await applyOpening(ctx.handles, { workspaceId: "ws2" }, {
      accountId: "acc-ws2",
      effectiveOn: occurredOn,
      balancePaise: 10_000_00,
      commit: true,
    });
    const otherSpend = await recordExpense(ctx.handles, { workspaceId: "ws2" }, {
      occurredOn,
      capturedAt,
      accountId: "acc-ws2",
      allocations: [{ categoryId: "cat-ws2", amountPaise: 500_00 }],
      commit: true,
    });
    await expect(
      correctExpenseTransaction(ctx.handles, { workspaceId: "ws2" }, {
        commandId: "shared-cmd",
        rootEventId: otherSpend.eventId,
        targetEventId: otherSpend.eventId,
        amountPaise: 400_00,
        sourceAccountId: "acc-ws2",
        occurredOn,
        allocations: [{ categoryId: "cat-ws2", amountPaise: 400_00 }],
        capturedAt,
        commit: true,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("refuses excluded families through the expense correction command", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 20_000_00,
      openingEffectiveOn: occurredOn,
    });
    const person = await createPerson(ctx.handles, { workspaceId: ctx.workspaceId }, { name: "Rahul" });
    const card = await createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: ctx.hdfcId,
    });

    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, {
      expectedAmountPaise: 7_920_000,
      windowStartDay: 4,
      typicalDay: 5,
      windowEndDay: 8,
      effectiveFrom: "2026-08-01",
    });
    const salary = await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "salary-1",
      occurredOn: "2026-08-05",
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 8_000_00,
      kind: "salary",
      expectedYear: 2026,
      expectedMonth: 8,
      commit: true,
    });
    const otherIncome = await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      amountPaise: 300_00,
      kind: "other",
      commit: true,
    });
    const transfer = await transferMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      amountPaise: 100_00,
      fromAccountId: ctx.hdfcId,
      toAccountId: pnb.id,
      commit: true,
    });
    const cardSpend = await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      creditCardId: card.id,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 200_00 }],
      commit: true,
    });
    const cycle = (await loadSnapshot(ctx.handles, ctx.workspaceId)).billingCycles.find((row) => row.creditCardId === card.id);
    if (!cycle) throw new Error("missing cycle");
    const cardPay = await payCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-22",
      capturedAt,
      creditCardId: card.id,
      billingCycleId: cycle.id,
      accountId: ctx.hdfcId,
      amountPaise: 200_00,
      commit: true,
    });
    const split = await recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      amountPaise: 400_00,
      source: { type: "account", accountId: ctx.hdfcId },
      userSharePaise: 200_00,
      personShares: [{ personId: person.id, amountPaise: 200_00 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 200_00 }],
      commit: true,
    });
    const lend = await lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      personId: person.id,
      amountPaise: 150_00,
      commit: true,
    });
    const borrow = await borrowMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      personId: person.id,
      amountPaise: 120_00,
      commit: true,
    });
    const afterBorrow = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const payable = afterBorrow.claims.find((claim) => claim.originatingEventId === borrow.eventId);
    const receivable = afterBorrow.claims.find((claim) => claim.originatingEventId === lend.eventId);
    if (!payable || !receivable) throw new Error("missing claims");
    const settleIn = await receiveSettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      personId: person.id,
      amountPaise: 50_00,
      allocations: [{ claimId: receivable.id, amountPaise: 50_00 }],
      commit: true,
    });
    const settleOut = await paySettlement(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      personId: person.id,
      amountPaise: 40_00,
      allocations: [{ claimId: payable.id, amountPaise: 40_00 }],
      commit: true,
    });
    const obligation = await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Rent",
      dueOn: "2026-08-18",
      amountPaise: 500_00,
      priority: "must_pay",
    });
    const obligationPay = await recordObligationPayment(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-18",
      capturedAt,
      instanceId: obligation.id,
      accountId: ctx.hdfcId,
      amountPaise: 500_00,
      commit: true,
    });
    const reserveCard = await createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "Axis",
      issuer: "Axis",
      mask: "4321",
      statementDay: 5,
      dueDaysAfterStatement: 20,
      defaultPaymentAccountId: pnb.id,
    });
    await applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "res-excl",
      occurredOn,
      capturedAt,
      sourceAccountId: pnb.id,
      cardId: reserveCard.id,
      amountPaise: 300_00,
    });
    const snap = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const opening = snap.events.find((event) => event.meaning.startsWith("apply_opening") && event.accountId === ctx.hdfcId);
    const reservationEvent = snap.events.find((event) => event.meaning.includes("reservation"));
    const excluded = [
      salary.eventId,
      otherIncome.eventId,
      transfer.eventId,
      cardSpend.eventId,
      cardPay.eventId,
      split.eventId,
      lend.eventId,
      borrow.eventId,
      settleIn.eventId,
      settleOut.eventId,
      obligationPay.eventId,
      opening?.id,
      reservationEvent?.id,
    ];
    for (const eventId of excluded) {
      if (!eventId) continue;
      await expect(
        correctExpenseTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, {
          commandId: newId(),
          rootEventId: eventId,
          targetEventId: eventId,
          amountPaise: 100_00,
          sourceAccountId: ctx.hdfcId,
          occurredOn,
          allocations: [{ categoryId: ctx.groceryId, amountPaise: 100_00 }],
          capturedAt,
          commit: true,
        }),
      ).rejects.toMatchObject({ code: "transaction_not_correctable" });
    }
  });

  it("maps expected conflicts through POST /api/commands/expense/correct", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    ctx.handles.sqlite
      .prepare(
        "INSERT INTO users (id, firebase_uid, display_name, primary_email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("user-a-row", "user-a", "A", "user-a@example.test", "active", capturedAt, capturedAt);
    ctx.handles.sqlite
      .prepare(
        "INSERT INTO workspace_memberships (id, user_id, workspace_id, role, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("mem-a", "user-a-row", ctx.workspaceId, "owner", capturedAt);
    const app = createApp(ctx.handles, { verifyIdToken });
    const headers = {
      authorization: "Bearer user-a",
      origin: "http://localhost:5173",
      "content-type": "application/json",
    };
    await app.request("/api/me", { headers: { authorization: "Bearer user-a" } });
    const recorded = await spend(ctx, 1_850_00);
    const dateRes = await app.request("/api/commands/expense/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, recorded.eventId!, 1_580_00, { occurredOn: "2026-07-01" })),
    });
    expect(dateRes.status).toBe(400);
    expect(await dateRes.json()).toMatchObject({ error: "invalid_correction_date" });

    const ok = await app.request("/api/commands/expense/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, recorded.eventId!, 1_580_00, { commandId: "http-1" })),
    });
    expect(ok.status).toBe(200);
    const payload = (await ok.json()) as { replacementEventId: string; rootEventId: string };
    const detail = await app.request(`/api/activity/${recorded.eventId}`, {
      headers: { authorization: "Bearer user-a" },
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { canCorrect: boolean; amountPaise: number };
    expect(body.canCorrect).toBe(true);
    expect(body.amountPaise).toBe(1_580_00);

    const stale = await app.request("/api/commands/expense/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, recorded.eventId!, 1_500_00, { rootEventId: payload.rootEventId })),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_correction_target" });
    void payload.replacementEventId;
  });
});
