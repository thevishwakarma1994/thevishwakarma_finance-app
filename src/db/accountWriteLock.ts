import { eq, sql } from "drizzle-orm";
import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles } from "./handles.js";
import { anyDb, queryGet, tables } from "./exec.js";
import { withPostgresTransaction, withSqliteImmediateTransaction } from "./tx.js";

function uniqueSortedAccountIds(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds.filter((id) => id.length > 0))].sort((left, right) => left.localeCompare(right));
}

/**
 * Serialize writers that move account cash so they cannot race a later
 * expense/income correction on the same rows.
 *
 * Lock order when this helper is used alone: accounts by lexical id.
 * Combined with an existing card lock: card row first (already held), then
 * these account rows. Combined with the workspace salary lock: workspace row
 * first, then these account rows. Never invert those orders.
 *
 * Postgres: `SELECT … FOR UPDATE` on the sorted account ids inside one
 * transaction. SQLite: `BEGIN IMMEDIATE` plus ownership SELECTs. Nested
 * callers join the open transaction.
 */
export async function withAccountWriteLocks<T>(
  handles: DbHandles,
  workspaceId: string,
  accountIds: readonly string[],
  fn: (txHandles: DbHandles) => T | Promise<T>,
): Promise<T> {
  const ids = uniqueSortedAccountIds(accountIds);
  if (handles.dialect === "sqlite") {
    return withSqliteImmediateTransaction(handles, async (txHandles) => {
      await lockSqliteAccounts(txHandles, workspaceId, ids);
      return fn(txHandles);
    });
  }
  return withPostgresTransaction(handles, async (txHandles) => {
    await lockPostgresAccounts(txHandles, workspaceId, ids);
    return fn(txHandles);
  });
}

async function lockSqliteAccounts(
  handles: DbHandles,
  workspaceId: string,
  ids: string[],
): Promise<void> {
  for (const id of ids) {
    await assertLockedAccount(handles, workspaceId, id);
  }
}

async function lockPostgresAccounts(
  handles: Extract<DbHandles, { dialect: "postgres" }>,
  workspaceId: string,
  ids: string[],
): Promise<void> {
  if (ids.length > 0) {
    await handles.db.execute(
      sql`SELECT id FROM accounts WHERE workspace_id = ${workspaceId} AND id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}) ORDER BY id FOR UPDATE`,
    );
  }
  for (const id of ids) {
    await assertLockedAccount(handles, workspaceId, id);
  }
}

async function assertLockedAccount(
  handles: DbHandles,
  workspaceId: string,
  accountId: string,
): Promise<void> {
  const t = tables(handles);
  const row = await queryGet<{ id: string; workspaceId: string }>(
    handles,
    anyDb(handles)
      .select({ id: t.accounts.id, workspaceId: t.accounts.workspaceId })
      .from(t.accounts)
      .where(eq(t.accounts.id, accountId)),
  );
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("account_not_found", "Account not found");
  }
}
