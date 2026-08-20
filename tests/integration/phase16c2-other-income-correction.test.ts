import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { persistAtomicCorrection } from "../../src/db/persistCorrection.js";
import {
  home,
  listActivity,
  money,
  publicTransactionDetail,
} from "../../src/db/reads.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { createAccount } from "../../src/app/accounts.js";
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
import { correctOtherIncomeTransaction } from "../../src/app/correctOtherIncome.js";
import { correctOtherIncome } from "../../src/domain/commands/correctOtherIncome.js";
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
  if (!hdfc) throw new Error("expected seed");
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: occurredOn,
    balancePaise: 10_000_00,
    commit: true,
  });
  return { handles, workspaceId, hdfcId: hdfc.id };
}

async function receive(
  ctx: Awaited<ReturnType<typeof setup>>,
  amountPaise: number,
  extras: { accountId?: string; notes?: string | null; kind?: "other" | "salary" } = {},
) {
  return recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
    occurredOn,
    capturedAt,
    accountId: extras.accountId ?? ctx.hdfcId,
    amountPaise,
    kind: extras.kind ?? "other",
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
    destinationAccountId?: string;
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
    destinationAccountId: extras.destinationAccountId ?? ctx.hdfcId,
    occurredOn: extras.occurredOn ?? occurredOn,
    notes: extras.notes,
    reason: extras.reason,
    capturedAt,
    commit: extras.commit ?? true,
  };
}

function otherIncomeTotal(snapshot: Awaited<ReturnType<typeof loadSnapshot>>): number {
  return snapshot.postings
    .filter((posting) => posting.pnl === "income_other")
    .reduce((sum, posting) => sum + posting.amountPaise, 0);
}

describe("phase 16c2 other-income correction", () => {
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
    handles = undefined;
  });

  it("corrects 5000 to 4500 with folded Activity, reports, Home, Money, and STS", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await receive(ctx, 5_000_00);
    const result = await correctOtherIncomeTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 4_500_00, { reason: "Wrong amount" }),
    );
    expect(result.committed).toBe(true);
    expect(result.correctionCount).toBe(1);

    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(14_500_00);
    expect(otherIncomeTotal(snapshot)).toBe(4_500_00);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    const incomeRows = activity.filter((event) => event.meaning === "income");
    expect(incomeRows).toHaveLength(1);
    expect(incomeRows[0]?.amountPaise).toBe(4_500_00);
    expect(incomeRows[0]?.corrected).toBe(true);
    expect(activity.some((event) => event.meaning === "transaction_reversal")).toBe(false);
    const moneyView = await money(ctx.handles, ctx.workspaceId);
    expect(moneyView.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(14_500_00);
    const homeView = await home(ctx.handles, ctx.workspaceId);
    expect(homeView.accounts.find((account) => account.accountId === ctx.hdfcId)?.balancePaise).toBe(14_500_00);
    const sts = evaluateSafeToSpend(snapshot, isoDate("2026-08-20"));
    expect(sts.accounts.find((account) => account.accountId === ctx.hdfcId)?.balancePaise).toBe(14_500_00);
    expect(accountAvailability(snapshot, ctx.hdfcId).availablePaise).toBe(14_500_00);

    const card = await createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: ctx.hdfcId,
    });
    await applyOpeningReservation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      commandId: "protect-cash",
      occurredOn: "2026-08-20",
      capturedAt,
      sourceAccountId: ctx.hdfcId,
      cardId: card.id,
      amountPaise: 4_000_00,
    });
    const reserved = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(accountAvailability(reserved, ctx.hdfcId).balancePaise).toBe(14_500_00);
    expect(accountAvailability(reserved, ctx.hdfcId).availablePaise).toBe(10_500_00);
    const reservedMoney = await money(ctx.handles, ctx.workspaceId);
    expect(reservedMoney.accounts.find((account) => account.id === ctx.hdfcId)?.availablePaise).toBe(10_500_00);

    const detail = await publicTransactionDetail(ctx.handles, ctx.workspaceId, recorded.eventId!);
    expect(detail?.amountPaise).toBe(4_500_00);
    expect(detail?.canCorrect).toBe(true);
    expect(detail?.correctionFamily).toBe("other_income");
    expect(detail?.history).toHaveLength(1);
    expect(detail?.history[0]?.reason).toBe("Wrong amount");
    expect(JSON.stringify(detail)).not.toMatch(/reversal_of_event_id|transaction_corrections|income_other/i);
  });

  it("increases amount and changes notes on the replacement only", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await receive(ctx, 5_000_00, { notes: "Freelance payment" });
    const result = await correctOtherIncomeTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 5_500_00, { notes: "Client refund" }),
    );
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(15_500_00);
    expect(snapshot.events.find((event) => event.id === recorded.eventId)?.notes).toBe("Freelance payment");
    expect(snapshot.events.find((event) => event.id === result.replacementEventId)?.notes).toBe("Client refund");
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity.filter((event) => event.meaning === "income")).toHaveLength(1);
    expect(activity[0]?.amountPaise).toBe(5_500_00);
  });

  it("moves destination account HDFC → PNB", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 1_000_00,
      openingEffectiveOn: occurredOn,
    });
    const recorded = await receive(ctx, 5_000_00);
    await correctOtherIncomeTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 5_000_00, { destinationAccountId: pnb.id, reason: "Wrong account" }),
    );
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.accounts.find((account) => account.id === ctx.hdfcId)?.balancePaise).toBe(10_000_00);
    expect(snapshot.accounts.find((account) => account.id === pnb.id)?.balancePaise).toBe(6_000_00);
    expect(otherIncomeTotal(snapshot)).toBe(5_000_00);
  });

  it("supports a second sequential correction and rejects a stale target", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 1_000_00,
      openingEffectiveOn: occurredOn,
    });
    const recorded = await receive(ctx, 5_000_00);
    const first = await correctOtherIncomeTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 4_500_00, { commandId: "first", reason: "Wrong amount" }),
    );
    const second = await correctOtherIncomeTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, first.replacementEventId!, 4_500_00, {
        commandId: "second",
        rootEventId: first.rootEventId,
        destinationAccountId: pnb.id,
        reason: "Wrong account",
      }),
    );
    expect(second.correctionCount).toBe(2);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity.filter((event) => event.meaning === "income")).toHaveLength(1);
    expect(activity[0]?.amountPaise).toBe(4_500_00);
    const detail = await publicTransactionDetail(ctx.handles, ctx.workspaceId, recorded.eventId!);
    expect(detail?.history).toHaveLength(2);
    await expect(
      correctOtherIncomeTransaction(
        ctx.handles,
        { workspaceId: ctx.workspaceId },
        correctionBody(ctx, recorded.eventId!, 4_000_00, { rootEventId: first.rootEventId }),
      ),
    ).rejects.toMatchObject({ code: "stale_correction_target" });
  });

  it("rejects spent income, reserved money, and pending surplus without artifacts", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const grocery = (await loadSnapshot(ctx.handles, ctx.workspaceId)).categories.find((category) => category.name === "Grocery");
    if (!grocery) throw new Error("expected grocery");
    const recorded = await receive(ctx, 5_000_00);
    await recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: grocery.id, amountPaise: 14_800_00 }],
      commit: true,
    });
    await expect(
      correctOtherIncomeTransaction(
        ctx.handles,
        { workspaceId: ctx.workspaceId },
        correctionBody(ctx, recorded.eventId!, 4_000_00),
      ),
    ).rejects.toMatchObject({ code: "insufficient_available" });
    expect((await loadSnapshot(ctx.handles, ctx.workspaceId)).transactionCorrections).toHaveLength(0);

    const reservedCtx = await setup();
    handles?.sqlite.close();
    handles = reservedCtx.handles;
    const reservedIncome = await receive(reservedCtx, 5_000_00);
    const card = await createCard(reservedCtx.handles, { workspaceId: reservedCtx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      defaultPaymentAccountId: reservedCtx.hdfcId,
    });
    await applyOpeningReservation(reservedCtx.handles, { workspaceId: reservedCtx.workspaceId }, {
      commandId: "res-hdfc",
      occurredOn,
      capturedAt,
      sourceAccountId: reservedCtx.hdfcId,
      cardId: card.id,
      amountPaise: 14_600_00,
    });
    await expect(
      correctOtherIncomeTransaction(
        reservedCtx.handles,
        { workspaceId: reservedCtx.workspaceId },
        correctionBody(reservedCtx, reservedIncome.eventId!, 4_000_00),
      ),
    ).rejects.toMatchObject({ code: "correction_would_use_reserved_money" });

    const surplusCtx = await setup();
    handles.sqlite.close();
    handles = surplusCtx.handles;
    const surplusIncome = await receive(surplusCtx, 5_000_00);
    surplusCtx.handles.sqlite.prepare(
      `INSERT INTO surplus_cases (id, workspace_id, amount_paise, kind, source_account_id, explanation, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("surplus-1", surplusCtx.workspaceId, 14_600_00, "unallocated_settlement", surplusCtx.hdfcId, "Pending", "pending");
    await expect(
      correctOtherIncomeTransaction(
        surplusCtx.handles,
        { workspaceId: surplusCtx.workspaceId },
        correctionBody(surplusCtx, surplusIncome.eventId!, 4_000_00),
      ),
    ).rejects.toMatchObject({ code: "correction_would_use_reserved_money" });
  });

  it("replays an exact retry and conflicts on material changes", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 1_000_00,
      openingEffectiveOn: occurredOn,
    });
    const recorded = await receive(ctx, 5_000_00, { notes: "Freelance payment" });
    const body = correctionBody(ctx, recorded.eventId!, 4_500_00, {
      commandId: "idem-1",
      notes: "Freelance payment",
      reason: "Wrong amount",
    });
    const first = await correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, body);
    const replay = await correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, body);
    expect(replay.replayed).toBe(true);
    expect(replay.correctionId).toBe(first.correctionId);
    expect(replay.reversalEventId).toBe(first.reversalEventId);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity.filter((event) => event.meaning === "income")).toHaveLength(1);

    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, amountPaise: 4_000_00 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, destinationAccountId: pnb.id }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, notes: "Client refund" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, reason: "other" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, occurredOn: "2026-08-02" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, targetEventId: newId() }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, { ...body, rootEventId: newId() }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects cross-workspace reuse of the same commandId", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await receive(ctx, 5_000_00);
    await correctOtherIncomeTransaction(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      correctionBody(ctx, recorded.eventId!, 4_500_00, { commandId: "shared-cmd" }),
    );
    ctx.handles.sqlite.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, '2026-08-01')").run("ws2", "Other");
    ctx.handles.sqlite.prepare(
      "INSERT INTO accounts (id, workspace_id, kind, display_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("acc-ws2", "ws2", "bank", "HDFC", "active", "2026-08-01");
    await applyOpening(ctx.handles, { workspaceId: "ws2" }, {
      accountId: "acc-ws2",
      effectiveOn: occurredOn,
      balancePaise: 10_000_00,
      commit: true,
    });
    const otherIncome = await recordIncome(ctx.handles, { workspaceId: "ws2" }, {
      occurredOn,
      capturedAt,
      accountId: "acc-ws2",
      amountPaise: 5_000_00,
      kind: "other",
      commit: true,
    });
    await expect(
      correctOtherIncomeTransaction(ctx.handles, { workspaceId: "ws2" }, {
        commandId: "shared-cmd",
        rootEventId: otherIncome.eventId,
        targetEventId: otherIncome.eventId,
        amountPaise: 4_500_00,
        destinationAccountId: "acc-ws2",
        occurredOn,
        capturedAt,
        commit: true,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rolls back each persist stage with no partial correction", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const stages = [
      "reversal_event",
      "reversal_postings",
      "replacement_event",
      "replacement_postings",
      "correction_row",
    ] as const;
    for (const failAfter of stages) {
      const recorded = await receive(ctx, 3_000_00);
      const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
      const prepared = correctOtherIncome(
        {
          commandId: `halt-${failAfter}`,
          rootEventId: recorded.eventId!,
          targetEventId: recorded.eventId!,
          amountPaise: 2_500_00,
          destinationAccountId: ctx.hdfcId,
          occurredOn,
          capturedAt,
        },
        snapshot,
      );
      await expect(
        persistAtomicCorrection(ctx.handles, ctx.workspaceId, {
          commandId: `halt-${failAfter}`,
          rootEventId: prepared.rootEventId,
          targetEventId: prepared.targetEventId,
          targetEvent: prepared.targetEvent,
          targetPostings: prepared.targetPostings,
          reversalEvent: prepared.reversalEvent,
          reversalPostings: prepared.reversalPostings,
          replacementEvent: prepared.replacementEvent,
          replacementPostings: prepared.replacementPostings,
          correctedOn: "2026-08-20",
          capturedAt,
          reason: prepared.material.reason,
          material: prepared.material,
          failAfter,
        }),
      ).rejects.toThrow(/correction persist test halt/);
      const after = await loadSnapshot(ctx.handles, ctx.workspaceId);
      expect(after.transactionCorrections).toHaveLength(0);
      expect(after.events.filter((event) => event.meaning === "transaction_reversal")).toHaveLength(0);
    }
  });

  it("cannot correct excluded families including salary", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const grocery = snapshot.categories.find((category) => category.name === "Grocery");
    if (!grocery) throw new Error("expected grocery");
    const pnb = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "PNB",
      kind: "bank",
      openingBalancePaise: 5_000_00,
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
      expectedAmountPaise: 8_000_00,
      typicalDay: 5,
      windowStartDay: 4,
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
    const expense = await recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: grocery.id, amountPaise: 100_00 }],
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
      allocations: [{ categoryId: grocery.id, amountPaise: 200_00 }],
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
      allocations: [{ categoryId: grocery.id, amountPaise: 200_00 }],
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
    const excluded = [
      salary.eventId,
      expense.eventId,
      transfer.eventId,
      cardSpend.eventId,
      cardPay.eventId,
      split.eventId,
      lend.eventId,
      borrow.eventId,
      settleIn.eventId,
      settleOut.eventId,
      obligationPay.eventId,
    ];
    for (const eventId of excluded) {
      if (!eventId) continue;
      await expect(
        correctOtherIncomeTransaction(ctx.handles, { workspaceId: ctx.workspaceId }, {
          commandId: newId(),
          rootEventId: eventId,
          targetEventId: eventId,
          amountPaise: 100_00,
          destinationAccountId: ctx.hdfcId,
          occurredOn,
          capturedAt,
          commit: true,
        }),
      ).rejects.toMatchObject({ code: "transaction_not_correctable" });
    }
    const salaryDetail = await publicTransactionDetail(ctx.handles, ctx.workspaceId, salary.eventId!);
    expect(salaryDetail?.canCorrect).toBe(false);
    expect(salaryDetail?.correctionFamily).toBeNull();
  });

  it("maps expected conflicts through POST /api/commands/income/correct", async () => {
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
    const recorded = await receive(ctx, 5_000_00);
    const dateRes = await app.request("/api/commands/income/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, recorded.eventId!, 4_500_00, { occurredOn: "2026-07-01" })),
    });
    expect(dateRes.status).toBe(400);
    expect(await dateRes.json()).toMatchObject({ error: "invalid_correction_date" });

    const ok = await app.request("/api/commands/income/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, recorded.eventId!, 4_500_00, { commandId: "http-1" })),
    });
    expect(ok.status).toBe(200);
    const stale = await app.request("/api/commands/income/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, recorded.eventId!, 4_000_00)),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_correction_target" });

    const conflict = await app.request("/api/commands/income/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, recorded.eventId!, 4_000_00, { commandId: "http-1" })),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "idempotency_conflict" });

    const grocery = (await loadSnapshot(ctx.handles, ctx.workspaceId)).categories.find((category) => category.name === "Grocery");
    if (!grocery) throw new Error("expected grocery");
    const expense = await recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn,
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: grocery.id, amountPaise: 100_00 }],
      commit: true,
    });
    const unsupported = await app.request("/api/commands/income/correct", {
      method: "POST",
      headers,
      body: JSON.stringify(correctionBody(ctx, expense.eventId!, 50_00)),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ error: "transaction_not_correctable" });
  });
});
