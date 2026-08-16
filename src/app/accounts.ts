import { z } from "zod";
import { eq } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import { accounts } from "../db/schema.js";
import { withTransaction } from "../db/tx.js";
import { applyOpening } from "./applyOpening.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

const createSchema = z.object({
  displayName: z.string().trim().min(1),
  kind: z.enum(["bank", "cash"]),
  mask: z.string().trim().nullable().optional(),
  isPrimarySalary: z.boolean().optional(),
  openingBalancePaise: z.number().int().nonnegative().optional(),
  openingEffectiveOn: z.string().optional(),
});

const updateSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string().trim().min(1).optional(),
  isPrimarySalary: z.boolean().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

function requireAccount(handles: SqliteHandles, workspaceId: string, accountId: string) {
  const row = handles.db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("account_not_found", "Account not found");
  }
  return row;
}

function clearPrimarySalary(handles: SqliteHandles, workspaceId: string): void {
  const rows = handles.db.select().from(accounts).where(eq(accounts.workspaceId, workspaceId)).all();
  for (const row of rows) {
    if (row.isPrimarySalary === 1) {
      handles.db.update(accounts).set({ isPrimarySalary: 0 }).where(eq(accounts.id, row.id)).run();
    }
  }
}

export function createAccount(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = createSchema.parse(raw);
  const id = newId();
  withTransaction(handles, () => {
    if (input.isPrimarySalary) {
      clearPrimarySalary(handles, context.workspaceId);
    }
    handles.db
      .insert(accounts)
      .values({
        id,
        workspaceId: context.workspaceId,
        kind: input.kind,
        displayName: input.displayName,
        mask: input.mask || null,
        isPrimarySalary: input.isPrimarySalary ? 1 : 0,
        status: "active",
        createdAt: utcNowIso(),
      })
      .run();
  });

  if (input.openingBalancePaise && input.openingBalancePaise > 0) {
    if (!input.openingEffectiveOn) {
      throw new DomainError("invalid_opening", "Opening date is required when setting an opening balance");
    }
    applyOpening(handles, context, {
      accountId: id,
      effectiveOn: input.openingEffectiveOn,
      balancePaise: input.openingBalancePaise,
      commit: true,
    });
  }

  return { id };
}

export function updateAccount(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = updateSchema.parse(raw);
  requireAccount(handles, context.workspaceId, input.accountId);

  withTransaction(handles, () => {
    if (input.isPrimarySalary) {
      clearPrimarySalary(handles, context.workspaceId);
    }
    const patch: {
      displayName?: string;
      isPrimarySalary?: number;
      status?: "active" | "archived";
    } = {};
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.isPrimarySalary !== undefined) patch.isPrimarySalary = input.isPrimarySalary ? 1 : 0;
    if (input.status !== undefined) {
      patch.status = input.status;
      if (input.status === "archived") patch.isPrimarySalary = 0;
    }
    if (Object.keys(patch).length > 0) {
      handles.db.update(accounts).set(patch).where(eq(accounts.id, input.accountId)).run();
    }
  });

  return { id: input.accountId };
}
