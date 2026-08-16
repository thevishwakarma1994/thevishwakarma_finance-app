import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import { categories } from "../db/schema.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

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

function requireCategory(handles: SqliteHandles, workspaceId: string, categoryId: string) {
  const row = handles.db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("category_not_found", "Category not found");
  }
  return row;
}

function assertUniqueActiveName(
  handles: SqliteHandles,
  workspaceId: string,
  parentId: string | null,
  name: string,
  exceptId?: string,
): void {
  const siblings = handles.db
    .select()
    .from(categories)
    .where(
      parentId
        ? and(eq(categories.workspaceId, workspaceId), eq(categories.parentId, parentId))
        : and(eq(categories.workspaceId, workspaceId), isNull(categories.parentId)),
    )
    .all();

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

export function createCategory(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = createSchema.parse(raw);
  const parentId = input.parentId ?? null;
  if (parentId) {
    const parent = requireCategory(handles, context.workspaceId, parentId);
    if (parent.archivedAt) {
      throw new DomainError("category_not_found", "Parent category is archived");
    }
  }
  assertUniqueActiveName(handles, context.workspaceId, parentId, input.name);
  const id = newId();
  handles.db
    .insert(categories)
    .values({
      id,
      workspaceId: context.workspaceId,
      parentId,
      name: input.name,
      archivedAt: null,
    })
    .run();
  return { id };
}

export function updateCategory(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = updateSchema.parse(raw);
  const existing = requireCategory(handles, context.workspaceId, input.categoryId);
  if (input.name !== undefined) {
    assertUniqueActiveName(
      handles,
      context.workspaceId,
      existing.parentId,
      input.name,
      existing.id,
    );
  }

  handles.db
    .update(categories)
    .set({
      name: input.name ?? existing.name,
      archivedAt: input.archive ? utcNowIso() : existing.archivedAt,
    })
    .where(eq(categories.id, existing.id))
    .run();

  return { id: existing.id };
}
