import { and, eq, gte, lte, sql } from "drizzle-orm";
import { paise } from "../domain/money/paise.js";
import { kolkataMonthEnd, kolkataMonthStart, todayKolkata } from "../domain/calendar/kolkata.js";
import { loadSnapshot } from "./loadSnapshot.js";
import { categories, financialEvents, postings } from "./schema.js";
import type { SqliteHandles } from "./client.js";

export function listAccounts(handles: SqliteHandles, workspaceId: string) {
  const snapshot = loadSnapshot(handles, workspaceId);
  return snapshot.accounts
    .filter((account) => account.status === "active")
    .map((account) => ({
      id: account.id,
      displayName: account.displayName,
      kind: account.kind,
      mask: account.mask,
      isPrimarySalary: account.isPrimarySalary,
      balancePaise: account.balancePaise,
    }));
}

export function listCategories(handles: SqliteHandles, workspaceId: string) {
  return handles.db
    .select()
    .from(categories)
    .where(eq(categories.workspaceId, workspaceId))
    .all()
    .filter((row) => !row.archivedAt)
    .map((row) => ({ id: row.id, name: row.name }));
}

export function listActivity(handles: SqliteHandles, workspaceId: string) {
  const snapshot = loadSnapshot(handles, workspaceId);
  const accountName = new Map(snapshot.accounts.map((account) => [account.id, account.displayName]));
  const categoryName = new Map(snapshot.categories.map((category) => [category.id, category.name]));

  return snapshot.events
    .filter((event) => event.meaning === "income" || event.meaning === "spend_account")
    .sort((a, b) => {
      if (a.occurredOn === b.occurredOn) return a.capturedAt < b.capturedAt ? 1 : -1;
      return a.occurredOn < b.occurredOn ? 1 : -1;
    })
    .map((event) => {
      const expensePostings = snapshot.postings.filter(
        (posting) => posting.eventId === event.id && posting.pnl === "expense",
      );
      const incomePostings = snapshot.postings.filter(
        (posting) =>
          posting.eventId === event.id &&
          (posting.pnl === "income_salary" || posting.pnl === "income_other"),
      );
      return {
        id: event.id,
        meaning: event.meaning,
        occurredOn: event.occurredOn,
        amountPaise: event.amountPaise,
        accountName: event.accountId ? (accountName.get(event.accountId) ?? null) : null,
        merchant: event.merchant,
        categories: expensePostings.map((posting) => ({
          name: posting.categoryId ? (categoryName.get(posting.categoryId) ?? "Expense") : "Expense",
          amountPaise: posting.amountPaise,
        })),
        incomeKind: incomePostings[0]?.pnl === "income_salary" ? "salary" : incomePostings[0]?.pnl === "income_other" ? "other" : null,
      };
    });
}

export function currentMonthSpend(handles: SqliteHandles, workspaceId: string, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  const rows = handles.db
    .select({
      total: sql<number>`coalesce(sum(${postings.amountPaise}), 0)`,
    })
    .from(postings)
    .innerJoin(financialEvents, eq(postings.eventId, financialEvents.id))
    .where(
      and(
        eq(postings.workspaceId, workspaceId),
        eq(postings.pnl, "expense"),
        gte(financialEvents.occurredOn, start),
        lte(financialEvents.occurredOn, end),
      ),
    )
    .get();

  return {
    asOf,
    month: asOf.slice(0, 7),
    spentPaise: paise(rows?.total ?? 0),
  };
}
