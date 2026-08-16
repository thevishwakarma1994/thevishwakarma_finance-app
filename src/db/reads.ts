import { and, eq, gte, lte, sql } from "drizzle-orm";
import { paise } from "../domain/money/paise.js";
import {
  kolkataAddMonths,
  kolkataMonthEnd,
  kolkataMonthStart,
  todayKolkata,
} from "../domain/calendar/kolkata.js";
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
      hasOpening: snapshot.openings.some(
        (opening) => opening.kind === "account" && opening.subjectId === account.id,
      ),
    }));
}

export function listCategories(handles: SqliteHandles, workspaceId: string, includeArchived = false) {
  return handles.db
    .select()
    .from(categories)
    .where(eq(categories.workspaceId, workspaceId))
    .all()
    .filter((row) => includeArchived || !row.archivedAt)
    .map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      archivedAt: row.archivedAt,
    }));
}

export type ActivityFilter = {
  categoryId?: string;
  month?: string;
};

export function listActivity(
  handles: SqliteHandles,
  workspaceId: string,
  filter: ActivityFilter = {},
) {
  const snapshot = loadSnapshot(handles, workspaceId);
  const accountName = new Map(snapshot.accounts.map((account) => [account.id, account.displayName]));
  const categoryName = new Map(snapshot.categories.map((category) => [category.id, category.name]));

  return snapshot.events
    .filter(
      (event) =>
        event.meaning === "income" || event.meaning === "spend_account" || event.meaning === "transfer",
    )
    .filter((event) => {
      if (!filter.month) return true;
      return event.occurredOn.startsWith(filter.month);
    })
    .filter((event) => {
      if (!filter.categoryId) return true;
      return snapshot.postings.some(
        (posting) =>
          posting.eventId === event.id &&
          posting.pnl === "expense" &&
          posting.categoryId === filter.categoryId,
      );
    })
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
      const accountPostings = snapshot.postings.filter(
        (posting) => posting.eventId === event.id && posting.accountId,
      );
      // Transfer convention: event.accountId is source; destination is the
      // positive account posting on the same event.
      const source = accountPostings.find((posting) => posting.amountPaise < 0);
      const destination = accountPostings.find((posting) => posting.amountPaise > 0);
      return {
        id: event.id,
        meaning: event.meaning,
        occurredOn: event.occurredOn,
        amountPaise: event.amountPaise,
        accountName: event.accountId ? (accountName.get(event.accountId) ?? null) : null,
        fromAccountName: source?.accountId ? (accountName.get(source.accountId) ?? null) : null,
        toAccountName: destination?.accountId
          ? (accountName.get(destination.accountId) ?? null)
          : null,
        merchant: event.merchant,
        categories: expensePostings.map((posting) => ({
          id: posting.categoryId,
          name: posting.categoryId ? (categoryName.get(posting.categoryId) ?? "Expense") : "Expense",
          amountPaise: posting.amountPaise,
        })),
        incomeKind:
          incomePostings[0]?.pnl === "income_salary"
            ? "salary"
            : incomePostings[0]?.pnl === "income_other"
              ? "other"
              : null,
      };
    });
}

function expenseTotalForMonth(
  handles: SqliteHandles,
  workspaceId: string,
  start: string,
  end: string,
): number {
  const row = handles.db
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
  return row?.total ?? 0;
}

export function currentMonthSpend(handles: SqliteHandles, workspaceId: string, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  return {
    asOf,
    month: asOf.slice(0, 7),
    spentPaise: paise(expenseTotalForMonth(handles, workspaceId, start, end)),
  };
}

export function monthReview(handles: SqliteHandles, workspaceId: string, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  const previousStart = kolkataMonthStart(kolkataAddMonths(start, -1));
  const previousEnd = kolkataMonthEnd(previousStart);
  const snapshot = loadSnapshot(handles, workspaceId);
  const categoryName = new Map(snapshot.categories.map((category) => [category.id, category.name]));

  const grouped = new Map<string, number>();
  for (const posting of snapshot.postings) {
    if (posting.pnl !== "expense" || !posting.categoryId) continue;
    const event = snapshot.events.find((item) => item.id === posting.eventId);
    if (!event) continue;
    if (event.occurredOn < start || event.occurredOn > end) continue;
    grouped.set(posting.categoryId, (grouped.get(posting.categoryId) ?? 0) + posting.amountPaise);
  }

  const spentPaise = expenseTotalForMonth(handles, workspaceId, start, end);
  const previousSpentPaise = expenseTotalForMonth(
    handles,
    workspaceId,
    previousStart,
    previousEnd,
  );

  return {
    asOf,
    month: start.slice(0, 7),
    spentPaise: paise(spentPaise),
    previousMonth: previousStart.slice(0, 7),
    previousSpentPaise: paise(previousSpentPaise),
    differencePaise: paise(spentPaise - previousSpentPaise),
    categories: [...grouped.entries()]
      .map(([categoryId, amount]) => ({
        categoryId,
        name: categoryName.get(categoryId) ?? "Expense",
        spentPaise: paise(amount),
      }))
      .sort((left, right) => right.spentPaise - left.spentPaise),
  };
}
