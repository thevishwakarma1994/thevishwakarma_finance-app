import { eq, sql } from "drizzle-orm";
import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles } from "./handles.js";
import { anyDb, queryGet, tables } from "./exec.js";
import { withPostgresTransaction, withSqliteImmediateTransaction } from "./tx.js";
import { withCreditCardWriteLock } from "./cardWriteLock.js";

function uniqueSortedAccountIds(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds.filter((id) => id.length > 0))].sort((left, right) => left.localeCompare(right));
}

/**
 * Project-wide financial lock graph — never invert:
 * 1. workspace lock, when needed (salary policy / salary receipt)
 * 2. credit-card lock, when needed
 * 3. account locks sorted lexicographically
 *
 * Never: account → card, account → workspace, card → workspace.
 *
 * Combined with an existing card lock: card row first (already held), then
 * these account rows. Combined with the workspace salary lock: workspace row
 * first, then these account rows.
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

/**
 * Card-funded writers that also move account cash: card row first, then
 * accounts by lexical id. Do not call this after an account lock.
 */
export async function withCardThenAccountWriteLocks<T>(
  handles: DbHandles,
  workspaceId: string,
  creditCardId: string,
  accountIds: readonly string[],
  fn: (txHandles: DbHandles) => T | Promise<T>,
): Promise<T> {
  return withCreditCardWriteLock(handles, workspaceId, creditCardId, (txHandles) =>
    withAccountWriteLocks(txHandles, workspaceId, accountIds, fn),
  );
}

/**
 * Billing-cycle reservation/surplus writers take card → accounts.
 * Non-card writers take accounts only.
 */
export async function withOptionalCardThenAccountWriteLocks<T>(
  handles: DbHandles,
  workspaceId: string,
  creditCardId: string | null,
  accountIds: readonly string[],
  fn: (txHandles: DbHandles) => T | Promise<T>,
): Promise<T> {
  if (creditCardId) {
    return withCardThenAccountWriteLocks(handles, workspaceId, creditCardId, accountIds, fn);
  }
  return withAccountWriteLocks(handles, workspaceId, accountIds, fn);
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
