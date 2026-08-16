import { z } from "zod";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import { applyOpening } from "./applyOpening.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { findAccount, insertAccount, updateAccountRow } from "../db/catalog.js";

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

async function requireAccount(handles: DbHandles, workspaceId: string, accountId: string) {
  const row = await findAccount(handles, accountId);
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("account_not_found", "Account not found");
  }
  return row;
}

export async function createAccount(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = createSchema.parse(raw);
  const id = newId();
  await insertAccount(
    handles,
    {
      id,
      workspaceId: context.workspaceId,
      kind: input.kind,
      displayName: input.displayName,
      mask: input.mask || null,
      isPrimarySalary: input.isPrimarySalary ? 1 : 0,
      status: "active",
      createdAt: utcNowIso(),
    },
    Boolean(input.isPrimarySalary),
  );

  if (input.openingBalancePaise && input.openingBalancePaise > 0) {
    if (!input.openingEffectiveOn) {
      throw new DomainError("invalid_opening", "Opening date is required when setting an opening balance");
    }
    await applyOpening(handles, context, {
      accountId: id,
      effectiveOn: input.openingEffectiveOn,
      balancePaise: input.openingBalancePaise,
      commit: true,
    });
  }

  return { id };
}

export async function updateAccount(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = updateSchema.parse(raw);
  await requireAccount(handles, context.workspaceId, input.accountId);

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
  await updateAccountRow(
    handles,
    input.accountId,
    context.workspaceId,
    patch,
    Boolean(input.isPrimarySalary),
  );

  return { id: input.accountId };
}
