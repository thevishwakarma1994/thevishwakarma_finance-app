import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { newId } from "../../src/domain/ids.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { currentMonthSpendFromSnapshot, listActivity, monthReview, transactionCorrectionDetail } from "../../src/db/reads.js";
import { accountAvailability } from "../../src/domain/engine/liquidity.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordExpense } from "../../src/app/recordExpense.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { persistAtomicCorrection } from "../../src/db/persistCorrection.js";
import { buildTransactionReversal } from "../../src/domain/corrections/reversal.js";
import { snapshotAfterReversal } from "../../src/domain/corrections/overlay.js";
import { recordExpense as recordExpenseDomain } from "../../src/domain/commands/recordExpense.js";
import { classifyCorrectionCandidate } from "../../src/domain/corrections/eligibility.js";
import { paise } from "../../src/domain/money/paise.js";
import { anyDb, tables } from "../../src/db/exec.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";

const capturedAt = "2026-08-01T10:00:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  if (!hdfc || !grocery) throw new Error("Expected seeded HDFC and Grocery");
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 50_000_00,
    commit: true,
  });
  return { handles, workspaceId, hdfcId: hdfc.id, groceryId: grocery.id };
}

async function spend(
  handles: SqliteHandles,
  workspaceId: string,
  hdfcId: string,
  groceryId: string,
  amountPaise: number,
  occurredOn = "2026-08-01",
) {
  return recordExpense(handles, { workspaceId }, {
    occurredOn,
    capturedAt,
    accountId: hdfcId,
    allocations: [{ categoryId: groceryId, amountPaise }],
    commit: true,
  });
}

async function correctExpense(args: {
  handles: SqliteHandles;
  workspaceId: string;
  hdfcId: string;
  groceryId: string;
  targetEventId: string;
  replacementAmountPaise: number;
  commandId: string;
  correctedOn: string;
  capturedAt: string;
  reason?: string | null;
}) {
  const snapshot = await loadSnapshot(args.handles, args.workspaceId);
  const target = snapshot.events.find((event) => event.id === args.targetEventId);
  if (!target) throw new Error("target missing");
  const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
  const reversal = buildTransactionReversal(target, targetPostings, args.capturedAt);
  const afterReversal = snapshotAfterReversal(
    snapshot,
    { events: [reversal.event], postings: reversal.postings },
    isoDate(args.correctedOn),
  );
  const replacement = recordExpenseDomain(
    {
      occurredOn: target.occurredOn,
      capturedAt: args.capturedAt,
      accountId: args.hdfcId,
      allocations: [{ categoryId: args.groceryId, amountPaise: paise(args.replacementAmountPaise) }],
    },
    afterReversal,
  );
  return persistAtomicCorrection(args.handles, args.workspaceId, {
    commandId: args.commandId,
    rootEventId: target.id,
    targetEventId: target.id,
    targetEvent: target,
    targetPostings,
    reversalEvent: reversal.event,
    reversalPostings: reversal.postings,
    replacementEvent: replacement.batch.events[0]!,
    replacementPostings: replacement.batch.postings,
    correctedOn: args.correctedOn,
    capturedAt: args.capturedAt,
    reason: args.reason ?? null,
  });
}

describe("phase 16c0 correction foundation", () => {
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
    handles = undefined;
  });

  it("leaves Activity unchanged when there are no corrections", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 500_00);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.id).toBe(recorded.eventId);
    expect(activity[0]?.meaning).toBe("spend_account");
    expect(activity[0]?.corrected).toBe(false);
    expect(activity[0]?.correctionCount).toBe(0);
    expect(activity[0]?.rootEventId).toBe(recorded.eventId);
    expect(activity[0]?.effectiveEventId).toBe(recorded.eventId);
  });

  it("folds original+reversal+replacement into one effective Activity row", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 1_200_00);
    const persisted = await correctExpense({
      ...ctx,
      targetEventId: recorded.eventId!,
      replacementAmountPaise: 800_00,
      commandId: "corr-1",
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T10:00:00.000Z",
    });
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.id).toBe(persisted.correction.replacementEventId);
    expect(activity[0]?.amountPaise).toBe(800_00);
    expect(activity[0]?.corrected).toBe(true);
    expect(activity[0]?.correctionCount).toBe(1);
    expect(activity[0]?.rootEventId).toBe(recorded.eventId);
    expect(activity.some((row) => row.meaning === "transaction_reversal")).toBe(false);
    expect(activity.some((row) => row.id === recorded.eventId)).toBe(false);

    const detail = await transactionCorrectionDetail(ctx.handles, ctx.workspaceId, recorded.eventId!);
    expect(detail?.rootEvent.id).toBe(recorded.eventId);
    expect(detail?.effectiveEvent.id).toBe(persisted.correction.replacementEventId);
    expect(detail?.history).toHaveLength(1);
    expect(detail?.history[0]?.correction.reason).toBeNull();
    expect(detail?.history[0]?.correction.capturedAt).toBe("2026-08-20T10:00:00.000Z");
  });

  it("nets original+reversal to zero and replacement as the final economic result", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const before = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const opening = before.accounts.find((account) => account.id === ctx.hdfcId)!.balancePaise;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 1_200_00);
    const afterSpend = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(afterSpend.accounts.find((account) => account.id === ctx.hdfcId)!.balancePaise).toBe(opening - 1_200_00);

    const reversalOnly = buildTransactionReversal(
      afterSpend.events.find((event) => event.id === recorded.eventId)!,
      afterSpend.postings.filter((posting) => posting.eventId === recorded.eventId),
      "2026-08-20T10:00:00.000Z",
    );
    const overlaid = snapshotAfterReversal(
      afterSpend,
      { events: [reversalOnly.event], postings: reversalOnly.postings },
      isoDate("2026-08-20"),
    );
    expect(overlaid.accounts.find((account) => account.id === ctx.hdfcId)!.balancePaise).toBe(opening);

    await correctExpense({
      ...ctx,
      targetEventId: recorded.eventId!,
      replacementAmountPaise: 400_00,
      commandId: "corr-report",
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T10:00:00.000Z",
    });
    const after = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.accounts.find((account) => account.id === ctx.hdfcId)!.balancePaise).toBe(opening - 400_00);
    const expensePnL = after.postings
      .filter((posting) => posting.pnl === "expense")
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(expensePnL).toBe(400_00);
    const incomePnL = after.postings
      .filter((posting) => posting.pnl === "income_other" || posting.pnl === "income_salary")
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(incomePnL).toBe(0);
    const review = await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"));
    expect(review.spentPaise).toBe(400_00);
    expect(review.categories[0]?.spentPaise).toBe(400_00);
    const month = currentMonthSpendFromSnapshot(after, isoDate("2026-08-20"));
    expect(month.spentPaise).toBe(400_00);
    expect(accountAvailability(after, ctx.hdfcId).balancePaise).toBe(opening - 400_00);
  });

  it("uses post-reversal available money for replacement validation", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 40_000_00);
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const target = snapshot.events.find((event) => event.id === recorded.eventId)!;
    const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
    const reversal = buildTransactionReversal(target, targetPostings, "2026-08-20T10:00:00.000Z");
    expect(() =>
      recordExpenseDomain(
        {
          occurredOn: target.occurredOn,
          capturedAt: "2026-08-20T10:00:00.000Z",
          accountId: ctx.hdfcId,
          allocations: [{ categoryId: ctx.groceryId, amountPaise: paise(20_000_00) }],
        },
        snapshot,
      ),
    ).toThrow(DomainError);
    const afterReversal = snapshotAfterReversal(
      snapshot,
      { events: [reversal.event], postings: reversal.postings },
      isoDate("2026-08-20"),
    );
    expect(
      recordExpenseDomain(
        {
          occurredOn: target.occurredOn,
          capturedAt: "2026-08-20T10:00:00.000Z",
          accountId: ctx.hdfcId,
          allocations: [{ categoryId: ctx.groceryId, amountPaise: paise(20_000_00) }],
        },
        afterReversal,
      ).batch.events[0]?.amountPaise,
    ).toBe(20_000_00);
  });

  it("treats the original as effective before the correction date and the replacement after", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 1_200_00);
    const persisted = await correctExpense({
      ...ctx,
      targetEventId: recorded.eventId!,
      replacementAmountPaise: 800_00,
      commandId: "corr-hist",
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T10:00:00.000Z",
    });
    const before = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-10"));
    expect(before.events.some((event) => event.id === recorded.eventId)).toBe(true);
    expect(before.events.some((event) => event.id === persisted.correction.replacementEventId)).toBe(false);
    expect(before.events.some((event) => event.meaning === "transaction_reversal")).toBe(false);
    const beforeSpend = currentMonthSpendFromSnapshot(before, isoDate("2026-08-10"));
    expect(beforeSpend.spentPaise).toBe(1_200_00);

    const after = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-25"));
    expect(after.events.some((event) => event.id === persisted.correction.replacementEventId)).toBe(true);
    expect(currentMonthSpendFromSnapshot(after, isoDate("2026-08-25")).spentPaise).toBe(800_00);
    const beforeActivity = await listActivity(ctx.handles, ctx.workspaceId, { asOf: "2026-08-10" });
    expect(beforeActivity[0]?.id).toBe(recorded.eventId);
    expect(beforeActivity[0]?.corrected).toBe(false);
    const afterActivity = await listActivity(ctx.handles, ctx.workspaceId, { asOf: "2026-08-25" });
    expect(afterActivity[0]?.id).toBe(persisted.correction.replacementEventId);
    expect(afterActivity[0]?.corrected).toBe(true);
  });

  it("replays an exact correction commandId and conflicts on a changed payload", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 500_00);
    const first = await correctExpense({
      ...ctx,
      targetEventId: recorded.eventId!,
      replacementAmountPaise: 400_00,
      commandId: "raw-corr",
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T10:00:00.000Z",
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const target = snapshot.events.find((event) => event.id === recorded.eventId)!;
    const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
    const replay = await persistAtomicCorrection(ctx.handles, ctx.workspaceId, {
      commandId: "raw-corr",
      rootEventId: first.correction.rootEventId,
      targetEventId: first.correction.targetEventId,
      targetEvent: target,
      targetPostings,
      reversalEvent: {
        ...target,
        id: first.correction.reversalEventId,
        meaning: "transaction_reversal",
        reversalOfEventId: target.id,
      },
      reversalPostings: [],
      replacementEvent: { ...target, id: first.correction.replacementEventId },
      replacementPostings: [],
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T10:00:00.000Z",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.correction.id).toBe(first.correction.id);

    await expect(
      persistAtomicCorrection(ctx.handles, ctx.workspaceId, {
        commandId: "raw-corr",
        rootEventId: target.id,
        targetEventId: target.id,
        targetEvent: target,
        targetPostings,
        reversalEvent: { ...target, id: newId(), meaning: "transaction_reversal", reversalOfEventId: target.id },
        reversalPostings: [],
        replacementEvent: { ...target, id: newId() },
        replacementPostings: [],
        correctedOn: "2026-08-20",
        capturedAt: "2026-08-20T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("conflicts when the same raw commandId is used in another workspace", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 500_00);
    await correctExpense({
      ...ctx,
      targetEventId: recorded.eventId!,
      replacementAmountPaise: 400_00,
      commandId: "shared-raw",
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T10:00:00.000Z",
    });
    const t = tables(ctx.handles);
    const otherWorkspaceId = newId();
    anyDb(ctx.handles).insert(t.workspaces).values({
      id: otherWorkspaceId,
      name: "other",
      createdAt: utcNowIso(),
    }).run();
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const target = snapshot.events.find((event) => event.id === recorded.eventId)!;
    const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
    const reversal = buildTransactionReversal(target, targetPostings, "2026-08-20T10:00:00.000Z");
    await expect(
      persistAtomicCorrection(ctx.handles, otherWorkspaceId, {
        commandId: "shared-raw",
        rootEventId: target.id,
        targetEventId: target.id,
        targetEvent: target,
        targetPostings,
        reversalEvent: reversal.event,
        reversalPostings: reversal.postings,
        replacementEvent: { ...target, id: newId() },
        replacementPostings: targetPostings.map((posting) => ({ ...posting, id: newId(), eventId: "x" })),
        correctedOn: "2026-08-20",
        capturedAt: "2026-08-20T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rolls back the reversal when replacement persistence fails", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 500_00);
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const target = snapshot.events.find((event) => event.id === recorded.eventId)!;
    const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
    const reversal = buildTransactionReversal(target, targetPostings, "2026-08-20T10:00:00.000Z");
    const afterReversal = snapshotAfterReversal(
      snapshot,
      { events: [reversal.event], postings: reversal.postings },
      isoDate("2026-08-20"),
    );
    const replacement = recordExpenseDomain(
      {
        occurredOn: target.occurredOn,
        capturedAt: "2026-08-20T10:00:00.000Z",
        accountId: ctx.hdfcId,
        allocations: [{ categoryId: ctx.groceryId, amountPaise: paise(200_00) }],
      },
      afterReversal,
    );
    await expect(
      persistAtomicCorrection(ctx.handles, ctx.workspaceId, {
        commandId: "boom-replace",
        rootEventId: target.id,
        targetEventId: target.id,
        targetEvent: target,
        targetPostings,
        reversalEvent: reversal.event,
        reversalPostings: reversal.postings,
        replacementEvent: { ...replacement.batch.events[0]!, id: target.id },
        replacementPostings: replacement.batch.postings,
        correctedOn: "2026-08-20",
        capturedAt: "2026-08-20T10:00:00.000Z",
      }),
    ).rejects.toBeTruthy();
    const after = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.events.filter((event) => event.meaning === "transaction_reversal")).toHaveLength(0);
    expect(after.transactionCorrections).toHaveLength(0);
    expect(after.events.filter((event) => event.meaning === "spend_account")).toHaveLength(1);
  });

  it("rolls back replacement and correction when reversal persistence fails", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const recorded = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 500_00);
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const target = snapshot.events.find((event) => event.id === recorded.eventId)!;
    const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
    const reversal = buildTransactionReversal(target, targetPostings, "2026-08-20T10:00:00.000Z");
    const afterReversal = snapshotAfterReversal(
      snapshot,
      { events: [reversal.event], postings: reversal.postings },
      isoDate("2026-08-20"),
    );
    const replacement = recordExpenseDomain(
      {
        occurredOn: target.occurredOn,
        capturedAt: "2026-08-20T10:00:00.000Z",
        accountId: ctx.hdfcId,
        allocations: [{ categoryId: ctx.groceryId, amountPaise: paise(200_00) }],
      },
      afterReversal,
    );
    await expect(
      persistAtomicCorrection(ctx.handles, ctx.workspaceId, {
        commandId: "boom-reversal",
        rootEventId: target.id,
        targetEventId: target.id,
        targetEvent: target,
        targetPostings,
        reversalEvent: { ...reversal.event, id: target.id },
        reversalPostings: reversal.postings,
        replacementEvent: replacement.batch.events[0]!,
        replacementPostings: replacement.batch.postings,
        correctedOn: "2026-08-20",
        capturedAt: "2026-08-20T10:00:00.000Z",
      }),
    ).rejects.toBeTruthy();
    const after = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.events).toHaveLength(1);
    expect(after.transactionCorrections).toHaveLength(0);
  });

  it("does not special-case a reversal of other income as new income", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const income = await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-01",
      capturedAt,
      amountPaise: 2_000_00,
      accountId: ctx.hdfcId,
      kind: "other",
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const target = snapshot.events.find((event) => event.id === income.eventId)!;
    const targetPostings = snapshot.postings.filter((posting) => posting.eventId === target.id);
    const reversal = buildTransactionReversal(target, targetPostings, "2026-08-20T10:00:00.000Z");
    const afterReversal = snapshotAfterReversal(
      snapshot,
      { events: [reversal.event], postings: reversal.postings },
      isoDate("2026-08-20"),
    );
    const { recordIncome: recordIncomeDomain } = await import("../../src/domain/commands/recordIncome.js");
    const replacement = recordIncomeDomain(
      {
        occurredOn: target.occurredOn,
        capturedAt: "2026-08-20T10:00:00.000Z",
        amountPaise: paise(1_500_00),
        accountId: ctx.hdfcId,
        kind: "other",
      },
      afterReversal,
    );
    await persistAtomicCorrection(ctx.handles, ctx.workspaceId, {
      commandId: "corr-income",
      rootEventId: target.id,
      targetEventId: target.id,
      targetEvent: target,
      targetPostings,
      reversalEvent: reversal.event,
      reversalPostings: reversal.postings,
      replacementEvent: replacement.batch.events[0]!,
      replacementPostings: replacement.batch.postings,
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T10:00:00.000Z",
    });
    const after = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const incomeTotal = after.postings
      .filter((posting) => posting.pnl === "income_other" || posting.pnl === "income_salary")
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(incomeTotal).toBe(1_500_00);
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity).toHaveLength(1);
    expect(activity[0]?.incomeKind).toBe("other");
    expect(activity[0]?.amountPaise).toBe(1_500_00);
  });

  it("classifies persisted simple expense and salary ineligibility", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const expense = await spend(ctx.handles, ctx.workspaceId, ctx.hdfcId, ctx.groceryId, 300_00);
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const expenseEvent = snapshot.events.find((event) => event.id === expense.eventId)!;
    expect(classifyCorrectionCandidate(expenseEvent, snapshot).ok).toBe(true);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      amountPaise: 1_000_00,
      accountId: ctx.hdfcId,
      kind: "salary",
      commit: true,
    });
    const afterSalary = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const salaryEvent = afterSalary.events.find((event) => event.meaning === "income")!;
    const classified = classifyCorrectionCandidate(salaryEvent, afterSalary);
    expect(classified.ok).toBe(false);
    if (!classified.ok) expect(classified.reason).toBe("salary_income");
  });
});
