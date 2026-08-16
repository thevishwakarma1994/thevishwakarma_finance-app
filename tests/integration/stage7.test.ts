import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { listAccounts, listActivity, monthReview } from "../../src/db/reads.js";
import { financialEvents, postings } from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordExpense } from "../../src/app/recordExpense.js";
import { transferMoney } from "../../src/app/transferMoney.js";
import { createAccount } from "../../src/app/accounts.js";
import { createCategory, updateCategory } from "../../src/app/categories.js";

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

async function balance(handles: SqliteHandles, workspaceId: string, accountId: string): Promise<number> {
  const account = (await loadSnapshot(handles, workspaceId)).accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Account missing");
  return account.balancePaise;
}

describe("transfers, categories, and month review", () => {
  const capturedAt = "2026-08-12T04:30:00.000Z";
  let handles: SqliteHandles | undefined;

  afterEach(() => {
    handles?.sqlite.close();
  });

  it("moves ₹2,000 from HDFC to Cash without changing personal spend", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const cash = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "Cash",
      kind: "cash",
    });
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 1_000_000,
      commit: true,
    });
    const spendBefore = (await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"))).spentPaise;
    await transferMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-12",
      capturedAt,
      amountPaise: 200_000,
      fromAccountId: ctx.hdfcId,
      toAccountId: cash.id,
      commit: true,
    });
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(800_000);
    expect(await balance(ctx.handles, ctx.workspaceId, cash.id)).toBe(200_000);
    expect((await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"))).spentPaise).toBe(
      spendBefore,
    );
  });

  it("writes nothing when a transfer fails conservation or validation", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const cash = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "Cash",
      kind: "cash",
    });
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 1_000_000,
      commit: true,
    });
    const before = tableCounts(ctx.handles, ctx.workspaceId);
    await expect(
      transferMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-12",
        capturedAt,
        amountPaise: 2_000_000,
        fromAccountId: ctx.hdfcId,
        toAccountId: cash.id,
        commit: true,
      }),
    ).rejects.toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(before);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(1_000_000);
  });

  it("keeps archived category names on historical activity", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 1_000_000,
      commit: true,
    });
    await recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-10",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 120_000 }],
      commit: true,
    });
    await updateCategory(ctx.handles, { workspaceId: ctx.workspaceId }, {
      categoryId: ctx.groceryId,
      name: "Groceries",
      archive: true,
    });
    const activity = await listActivity(ctx.handles, ctx.workspaceId);
    expect(activity[0]?.categories[0]?.name).toBe("Groceries");
  });

  it("rejects a duplicate active sibling category", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    await expect(
      createCategory(ctx.handles, { workspaceId: ctx.workspaceId }, { name: "Grocery" }),
    ).rejects.toThrow(/already exists/);
  });

  it("sums only expense postings in Month Review, including multi-category events", async () => {
    const ctx = await setup();
    handles = ctx.handles;
    const cash = await createAccount(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "Cash",
      kind: "cash",
    });
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      accountId: ctx.hdfcId,
      effectiveOn: "2026-08-01",
      balancePaise: 1_000_000,
      commit: true,
    });
    await recordExpense(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-07-20",
      capturedAt,
      accountId: ctx.hdfcId,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 100_000 }],
      commit: true,
    });
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
    await transferMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-13",
      capturedAt,
      amountPaise: 50_000,
      fromAccountId: ctx.hdfcId,
      toAccountId: cash.id,
      commit: true,
    });
    const review = await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    expect(review.month).toBe("2026-08");
    expect(review.previousMonth).toBe("2026-07");
    expect(review.spentPaise).toBe(300_000);
    expect(review.previousSpentPaise).toBe(100_000);
    expect(review.differencePaise).toBe(200_000);
    expect(review.categories.find((item) => item.name === "Grocery")?.spentPaise).toBe(180_000);
    expect(review.categories.find((item) => item.name === "Household")?.spentPaise).toBe(120_000);
    expect((await listActivity(ctx.handles, ctx.workspaceId)).some((event) => event.meaning === "transfer")).toBe(
      true,
    );
  });
});
