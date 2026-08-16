import { z } from "zod";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { findPerson, insertPersonRow, updatePersonRow } from "../db/catalog.js";

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

async function requirePerson(handles: DbHandles, workspaceId: string, personId: string) {
  const row = await findPerson(handles, personId);
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("person_not_found", "Person not found");
  }
  return row;
}

export async function createPerson(handles: DbHandles, context: WorkspaceContext, raw: unknown) {
  const input = createSchema.parse(raw);
  const id = newId();
  await insertPersonRow(handles, {
    id,
    workspaceId: context.workspaceId,
    name: input.name,
    notes: input.notes ?? null,
    status: "active",
    createdAt: utcNowIso(),
  });
  return { id };
}

export async function updatePerson(handles: DbHandles, context: WorkspaceContext, raw: unknown) {
  const input = updateSchema.parse(raw);
  const row = await requirePerson(handles, context.workspaceId, input.personId);
  const patch: { name?: string; notes?: string | null; status?: "active" | "archived" } = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.status !== undefined) patch.status = input.status;
  await updatePersonRow(handles, input.personId, patch);
  return { id: row.id };
}
