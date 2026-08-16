import { eq } from "drizzle-orm";
import { paise } from "../domain/money/paise.js";
import { isoDate } from "../domain/calendar/isoDate.js";
import type {
  LedgerAccount,
  LedgerSnapshot,
  OpeningPosition,
} from "../domain/ledger/types.js";
import { accounts, categories, financialEvents, openingPositions, postings } from "./schema.js";
import type { SqliteHandles } from "./client.js";

export function loadSnapshot(handles: SqliteHandles, workspaceId: string): LedgerSnapshot {
  const accountRows = handles.db
    .select()
    .from(accounts)
    .where(eq(accounts.workspaceId, workspaceId))
    .all();
  const categoryRows = handles.db
    .select()
    .from(categories)
    .where(eq(categories.workspaceId, workspaceId))
    .all();
  const eventRows = handles.db
    .select()
    .from(financialEvents)
    .where(eq(financialEvents.workspaceId, workspaceId))
    .all();
  const postingRows = handles.db
    .select()
    .from(postings)
    .where(eq(postings.workspaceId, workspaceId))
    .all();
  const openingRows = handles.db
    .select()
    .from(openingPositions)
    .where(eq(openingPositions.workspaceId, workspaceId))
    .all();

  const openings: OpeningPosition[] = openingRows.map((row) => {
    const payload = JSON.parse(row.payload) as { balancePaise: number };
    return {
      id: row.id,
      effectiveOn: isoDate(row.effectiveOn),
      kind: row.kind as OpeningPosition["kind"],
      subjectId: row.subjectId,
      payload: { balancePaise: paise(payload.balancePaise) },
    };
  });

  const ledgerAccounts: LedgerAccount[] = accountRows.map((row) => {
    const opening = openings.find(
      (item) => item.kind === "account" && item.subjectId === row.id,
    );
    const openingBalancePaise = opening?.payload.balancePaise ?? paise(0);
    const postedPaise = paise(
      postingRows
        .filter((posting) => posting.accountId === row.id)
        .reduce((sum, posting) => sum + posting.amountPaise, 0),
    );
    return {
      id: row.id,
      kind: row.kind as LedgerAccount["kind"],
      displayName: row.displayName,
      mask: row.mask,
      isPrimarySalary: row.isPrimarySalary === 1,
      status: row.status as LedgerAccount["status"],
      openingBalancePaise,
      postedPaise,
      balancePaise: paise(openingBalancePaise + postedPaise),
    };
  });

  return {
    accounts: ledgerAccounts,
    categories: categoryRows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      name: row.name,
    })),
    events: eventRows.map((row) => ({
      id: row.id,
      meaning: row.meaning as LedgerSnapshot["events"][number]["meaning"],
      occurredOn: isoDate(row.occurredOn),
      capturedAt: row.capturedAt,
      amountPaise: paise(row.amountPaise),
      accountId: row.accountId,
      creditCardId: null,
      loanId: null,
      billingCycleId: null,
      fundingCycleId: null,
      categoryId: row.categoryId,
      channel: row.channel,
      merchant: row.merchant,
      notes: row.notes,
      reversalOfEventId: row.reversalOfEventId,
    })),
    postings: postingRows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      amountPaise: paise(row.amountPaise),
      accountId: row.accountId,
      creditCardId: null,
      loanId: null,
      pnl: row.pnl as LedgerSnapshot["postings"][number]["pnl"],
      categoryId: row.categoryId,
      claimId: null,
      billingCycleId: null,
    })),
    openings,
  };
}

export function getAccountBalance(
  handles: SqliteHandles,
  workspaceId: string,
  accountId: string,
): number {
  const snapshot = loadSnapshot(handles, workspaceId);
  const account = snapshot.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("Account not found");
  }
  return account.balancePaise;
}
