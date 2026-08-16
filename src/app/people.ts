import { z } from "zod";
import { eq } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import { people } from "../db/schema.js";
import { withTransaction } from "../db/tx.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

const createSchema = z.object({
  name: z.string().trim().min(1),
  notes: z.string().trim().nullable().optional(),
});

const updateSchema = z.object({
  personId: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  notes: z.string().trim().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

function requirePerson(handles: SqliteHandles, workspaceId: string, personId: string) {
  const row = handles.db.select().from(people).where(eq(people.id, personId)).get();
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("person_not_found", "Person not found");
  }
  return row;
}

export function createPerson(handles: SqliteHandles, context: WorkspaceContext, raw: unknown) {
  const input = createSchema.parse(raw);
  const id = newId();
  withTransaction(handles, () => {
    handles.db
      .insert(people)
      .values({
        id,
        workspaceId: context.workspaceId,
        name: input.name,
        notes: input.notes ?? null,
        status: "active",
        createdAt: utcNowIso(),
      })
      .run();
  });
  return { id };
}

export function updatePerson(handles: SqliteHandles, context: WorkspaceContext, raw: unknown) {
  const input = updateSchema.parse(raw);
  const row = requirePerson(handles, context.workspaceId, input.personId);
  const patch: { name?: string; notes?: string | null; status?: "active" | "archived" } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length > 0) {
    handles.db.update(people).set(patch).where(eq(people.id, input.personId)).run();
  }
  return { id: row.id };
}
