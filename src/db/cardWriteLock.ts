import { eq, sql } from "drizzle-orm";
import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles } from "./handles.js";
import { anyDb, queryGet, tables } from "./exec.js";
import { withPostgresTransaction, withSqliteImmediateTransaction } from "./tx.js";

/**
 * Serialize every writer that can create card opening, opening correction, or
 * normal card lifecycle events (`apply_opening_card_position`,
 * `correct_opening_card_position`, `apply_opening_reservation`,
 * `correct_opening_reservation`, `spend_card`, `pay_obligation`, `split`,
 * `refund`) against one credit card.
 *
 * Lock order: the `credit_cards` row only, taken first and held until commit.
 * Commands that also touch accounts/claims/categories do not lock those rows
 * here, so ordering stays deterministic (card, then everything else un-locked).
 *
 * Postgres: `SELECT … FOR UPDATE` on that row inside one transaction.
 * SQLite: `BEGIN IMMEDIATE` (database write lock) plus ownership SELECT.
 */
export async function withCreditCardWriteLock<T>(
  handles: DbHandles,
  workspaceId: string,
  creditCardId: string,
  fn: (txHandles: DbHandles) => T | Promise<T>,
): Promise<T> {
  if (handles.dialect === "sqlite") {
    return withSqliteImmediateTransaction(handles, async (txHandles) => {
      await assertLockedCard(txHandles, workspaceId, creditCardId);
      return fn(txHandles);
    });
  }
  return withPostgresTransaction(handles, async (txHandles) => {
    await txHandles.db.execute(
      sql`SELECT id FROM credit_cards WHERE id = ${creditCardId} FOR UPDATE`,
    );
    await assertLockedCard(txHandles, workspaceId, creditCardId);
    return fn(txHandles);
  });
}

async function assertLockedCard(
  handles: DbHandles,
  workspaceId: string,
  creditCardId: string,
): Promise<void> {
  const t = tables(handles);
  const row = await queryGet<{ id: string; workspaceId: string }>(
    handles,
    anyDb(handles)
      .select({ id: t.creditCards.id, workspaceId: t.creditCards.workspaceId })
      .from(t.creditCards)
      .where(eq(t.creditCards.id, creditCardId)),
  );
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("card_not_found", "Credit card not found");
  }
}
