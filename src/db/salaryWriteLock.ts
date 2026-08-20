import { eq, sql } from "drizzle-orm";
import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles } from "./handles.js";
import { anyDb, queryGet, tables } from "./exec.js";
import { withPostgresTransaction, withSqliteImmediateTransaction } from "./tx.js";

/**
 * Serialize salary-policy version writes and cycle materialization for one workspace.
 *
 * Project-wide lock graph: workspace first, then accounts when a salary
 * receipt also moves cash. Never lock accounts (or a card) and then the
 * workspace row.
 */
export async function withWorkspaceSalaryWriteLock<T>(
  handles: DbHandles,
  workspaceId: string,
  fn: (txHandles: DbHandles) => T | Promise<T>,
): Promise<T> {
  if (handles.dialect === "sqlite") {
    return withSqliteImmediateTransaction(handles, async (txHandles) => {
      await assertLockedWorkspace(txHandles, workspaceId);
      return fn(txHandles);
    });
  }
  return withPostgresTransaction(handles, async (txHandles) => {
    await txHandles.db.execute(sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`);
    await assertLockedWorkspace(txHandles, workspaceId);
    return fn(txHandles);
  });
}

/**
 * Serialize actual salary receipts against one funding cycle.
 * Lock order: the `funding_cycles` row first.
 */
export async function withFundingCycleWriteLock<T>(
  handles: DbHandles,
  workspaceId: string,
  fundingCycleId: string,
  fn: (txHandles: DbHandles) => T | Promise<T>,
): Promise<T> {
  if (handles.dialect === "sqlite") {
    return withSqliteImmediateTransaction(handles, async (txHandles) => {
      await assertLockedFundingCycle(txHandles, workspaceId, fundingCycleId);
      return fn(txHandles);
    });
  }
  return withPostgresTransaction(handles, async (txHandles) => {
    await txHandles.db.execute(
      sql`SELECT id FROM funding_cycles WHERE id = ${fundingCycleId} FOR UPDATE`,
    );
    await assertLockedFundingCycle(txHandles, workspaceId, fundingCycleId);
    return fn(txHandles);
  });
}

async function assertLockedWorkspace(handles: DbHandles, workspaceId: string): Promise<void> {
  const t = tables(handles);
  const row = await queryGet<{ id: string }>(
    handles,
    anyDb(handles).select({ id: t.workspaces.id }).from(t.workspaces).where(eq(t.workspaces.id, workspaceId)),
  );
  if (!row) {
    throw new DomainError("workspace_not_found", "Workspace not found");
  }
}

async function assertLockedFundingCycle(
  handles: DbHandles,
  workspaceId: string,
  fundingCycleId: string,
): Promise<void> {
  const t = tables(handles);
  const row = await queryGet<{ id: string; workspaceId: string }>(
    handles,
    anyDb(handles)
      .select({ id: t.fundingCycles.id, workspaceId: t.fundingCycles.workspaceId })
      .from(t.fundingCycles)
      .where(eq(t.fundingCycles.id, fundingCycleId)),
  );
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("cycle_not_found", "Salary period not found");
  }
}
