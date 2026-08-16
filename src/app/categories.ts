import { z } from "zod";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import {
  findCategory,
  insertCategoryRow,
  listSiblingCategories,
  updateCategoryRow,
} from "../db/catalog.js";

const createSchema = z.object({
  name: z.string().trim().min(1),
  parentId: z.string().min(1).nullable().optional(),
});

const updateSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  archive: z.boolean().optional(),
});

function sameParent(left: string | null, right: string | null): boolean {
  return left === right;
}

async function requireCategory(handles: DbHandles, workspaceId: string, categoryId: string) {
  const row = await findCategory(handles, categoryId);
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("category_not_found", "Category not found");
  }
  return row;
}

async function assertUniqueActiveName(
  handles: DbHandles,
  workspaceId: string,
  parentId: string | null,
  name: string,
  exceptId?: string,
): Promise<void> {
  const siblings = await listSiblingCategories(handles, workspaceId, parentId);
  const duplicate = siblings.find(
    (row) =>
      !row.archivedAt &&
      row.id !== exceptId &&
      sameParent(row.parentId, parentId) &&
      row.name.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) {
    throw new DomainError("duplicate_category", "An active category with this name already exists here");
  }
}

export async function createCategory(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = createSchema.parse(raw);
  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = await requireCategory(handles, context.workspaceId, parentId);
    if (parent.archivedAt) {
      throw new DomainError("category_not_found", "Parent category is archived");
    }
  }
  await assertUniqueActiveName(handles, context.workspaceId, parentId, input.name);
  const id = newId();
  await insertCategoryRow(handles, {
    id,
    workspaceId: context.workspaceId,
    parentId,
    name: input.name,
    archivedAt: null,
  });
  return { id };
}

export async function updateCategory(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = updateSchema.parse(raw);
  const existing = await requireCategory(handles, context.workspaceId, input.categoryId);
  if (input.name !== undefined) {
    await assertUniqueActiveName(
      handles,
      context.workspaceId,
      existing.parentId,
      input.name,
      existing.id,
    );
  }

  await updateCategoryRow(handles, existing.id, {
    name: input.name ?? existing.name,
    archivedAt: input.archive ? utcNowIso() : existing.archivedAt,
  });

  return { id: existing.id };
}
