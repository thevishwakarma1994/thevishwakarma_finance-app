import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { paise } from "../../src/domain/money/paise.js";
import { newId } from "../../src/domain/ids.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { persistBatch } from "../../src/db/persistBatch.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { currentMonthSpend, listAccounts, listActivity } from "../../src/db/reads.js";
import { financialEvents, postings } from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordIncome } from "../../src/app/recordIncome.js";
import { recordExpense } from "../../src/app/recordExpense.js";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const accounts = await listAccounts(handles, workspaceId);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected seeded HDFC account");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  const household = snapshot.categories.find((category) => category.name === "Household");
  if (!grocery || !household) throw new Error("Expected seeded categories");
  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    groceryId: grocery.id,
    householdId: household.id,
  };
}

function tableCounts(handles: SqliteHandles, workspaceId: string) {
  return {
    events:
      handles.db
        .select({ value: count() })
        .from(financialEvents)
        .where(eq(financialEvents.workspaceId, workspaceId))
        .get()?.value ?? 0,
    postings:
      handles.db
        .select({ value: count() })
        .from(postings)
        .where(eq(postings.workspaceId, workspaceId))
        .get()?.value ?? 0,
  };
}

async function incomeTotal(handles: SqliteHandles, workspaceId: string): Promise<number> {
  return (await loadSnapshot(handles, workspaceId))
    .postings.filter(
      (posting) => posting.pnl === "income_salary" || posting.pnl === "income_other",
    )
    .reduce((sum, posting) => sum + posting.amountPaise, 0);
}

async function accountBalance(handles: SqliteHandles, workspaceId: string, accountId: string): Promise<number> {
  const account = (await loadSnapshot(handles, workspaceId)).accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Account missing");
  return account.balancePaise;
}

describe("opening, income, and expense persistence", () => {
  const capturedAt = "2026-08-05T04:30:00.000Z";
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
  });

  it("sets opening ₹50,000 without creating income", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 5_000_000,
      commit: true,
    });
    expect(await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(5_000_000);
    expect(await incomeTotal(ctx.handles, ctx.workspaceId)).toBe(0);
    expect(await listActivity(ctx.handles, ctx.workspaceId)).toHaveLength(0);
  });

  it("records ₹79,200 salary into HDFC", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 5_000_000,
      commit: true,
    });
    const before = await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    await recordIncome(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      amountPaise: 7_920_000,
      accountId: ctx.hdfcId,
      kind: "salary",
      commit: true,
    });
    expect((await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId)) - before).toBe(7_920_000);
    expect(await incomeTotal(ctx.handles, ctx.workspaceId)).toBe(7_920_000);
  });

  it("records ₹1,200 grocery as personal spending", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 5_000_000,
      commit: true,
    });
    const before = await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    await recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-10",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 120_000 }],
      commit: true,
    });
    expect(before - (await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId))).toBe(120_000);
    expect((await currentMonthSpend(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"))).spentPaise).toBe(
      120_000,
    );
  });

  it("conserves a ₹3,000 payment across two expense categories", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 5_000_000,
      commit: true,
    });
    const before = await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    await recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-12",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [
        { categoryId: ctx.groceryId, amountPaise: 180_000 },
        { categoryId: ctx.householdId, amountPaise: 120_000 },
      ],
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const event = snapshot.events.find((item) => item.meaning === "spend_account");
    expect(event).toBeTruthy();
    const expensePostings = snapshot.postings.filter(
      (posting) => posting.eventId === event?.id && posting.pnl === "expense",
    );
    const accountDecrease = -snapshot.postings
      .filter((posting) => posting.eventId === event?.id && posting.accountId)
      .reduce((sum, posting) => sum + posting.amountPaise, 0);
    expect(expensePostings).toHaveLength(2);
    expect(accountDecrease).toBe(300_000);
    expect(expensePostings.reduce((sum, posting) => sum + posting.amountPaise, 0)).toBe(300_000);
    expect(before - (await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId))).toBe(300_000);
  });

  it("does not write events or postings when conservation fails", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 5_000_000,
      commit: true,
    });
    const beforeCounts = tableCounts(ctx.handles, ctx.workspaceId);
    const beforeBalance = await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId);
    const eventId = newId();
    await expect(
      persistBatch(ctx.handles, ctx.workspaceId, {
        events: [
          {
            id: eventId,
            meaning: "income",
            occurredOn: isoDate("2026-08-05"),
            capturedAt,
            amountPaise: paise(7_920_000),
            accountId: ctx.hdfcId,
            creditCardId: null,
            loanId: null,
            billingCycleId: null,
            fundingCycleId: null,
            obligationInstanceId: null,
            categoryId: null,
            channel: null,
            merchant: null,
            notes: null,
            reversalOfEventId: null,
          },
        ],
        postings: [
          {
            id: newId(),
            eventId,
            amountPaise: paise(7_920_000),
            accountId: ctx.hdfcId,
            creditCardId: null,
            loanId: null,
            pnl: null,
            categoryId: null,
            claimId: null,
            billingCycleId: null,
          },
          {
            id: newId(),
            eventId,
            amountPaise: paise(100),
            accountId: null,
            creditCardId: null,
            loanId: null,
            pnl: "income_salary",
            categoryId: null,
            claimId: null,
            billingCycleId: null,
          },
        ],
        openings: [],
      }),
    ).rejects.toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(beforeCounts);
    expect(await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(beforeBalance);
  });

  it("rejects an expense that exceeds the currently available account balance", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 5_000_000,
      commit: true,
    });
    const beforeCounts = tableCounts(ctx.handles, ctx.workspaceId);
    await expect(
      recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-10",
        capturedAt,
        accountId: ctx.hdfcId,
        allocations: [{ categoryId: ctx.groceryId, amountPaise: 5_000_001 }],
        commit: true,
      }),
    ).rejects.toThrow(/exceeds the money currently in the account/);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(beforeCounts);
    expect(await accountBalance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(5_000_000);
  });
});
