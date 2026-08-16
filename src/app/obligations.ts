import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { newId } from "../domain/ids.js";
import { DomainError, type ObligationPriority } from "../domain/ledger/types.js";
import { parseDueRule } from "../domain/obligations/generate.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { ensureObligationInstances } from "./ensureObligationInstances.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import {
  archiveObligationTemplateRow,
  changeObligationTemplate,
  findObligationTemplate,
  insertObligationTemplateWithConfig,
  insertOneOffObligation,
} from "../db/catalog.js";

const prioritySchema = z.enum(["must_pay", "committed", "planned"]);

const createTemplateSchema = z.object({
  name: z.string().min(1),
  priority: prioritySchema,
  dayOfMonth: z.number().int().min(1).max(31),
  amountPaise: z.number().int().positive(),
  defaultAccountId: z.string().nullable().optional(),
  effectiveFrom: z.string(),
});

const changeFromSchema = z.object({
  templateId: z.string().min(1),
  effectiveFrom: z.string(),
  amountPaise: z.number().int().positive().optional(),
  priority: prioritySchema.optional(),
  name: z.string().min(1).optional(),
});

const archiveSchema = z.object({
  templateId: z.string().min(1),
  effectiveTo: z.string(),
});

const oneOffSchema = z.object({
  name: z.string().min(1),
  dueOn: z.string(),
  amountPaise: z.number().int().positive(),
  priority: prioritySchema,
});

export async function createObligationTemplate(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = createTemplateSchema.parse(raw);
  parseDueRule({ dayOfMonth: input.dayOfMonth });
  if (input.defaultAccountId) {
    await assertWorkspaceOwned(handles, context.workspaceId, [
      { type: "account", id: input.defaultAccountId },
    ]);
  }
  const id = newId();
  const effectiveFrom = isoDate(input.effectiveFrom);
  await insertObligationTemplateWithConfig(
    handles,
    {
      id,
      workspaceId: context.workspaceId,
      name: input.name,
      priority: input.priority,
      dueRule: JSON.stringify({ dayOfMonth: input.dayOfMonth }),
      defaultAccountId: input.defaultAccountId ?? null,
      loanId: null,
      effectiveFrom,
      effectiveTo: null,
    },
    input.amountPaise,
    input.priority,
  );
  await ensureObligationInstances(handles, context.workspaceId, effectiveFrom);
  return { id };
}

export async function changeObligationFrom(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = changeFromSchema.parse(raw);
  const effectiveFrom = isoDate(input.effectiveFrom);
  const existing = await findObligationTemplate(handles, input.templateId);
  if (!existing || existing.workspaceId !== context.workspaceId) {
    throw new DomainError("obligation_template_not_found", "Obligation template not found");
  }
  await changeObligationTemplate(handles, context.workspaceId, input.templateId, effectiveFrom, {
    name: input.name,
    amountPaise: input.amountPaise,
    priority: input.priority,
  });
  await ensureObligationInstances(handles, context.workspaceId, effectiveFrom);
  return { id: input.templateId };
}

export async function archiveObligationTemplate(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = archiveSchema.parse(raw);
  const existing = await findObligationTemplate(handles, input.templateId);
  if (!existing || existing.workspaceId !== context.workspaceId) {
    throw new DomainError("obligation_template_not_found", "Obligation template not found");
  }
  await archiveObligationTemplateRow(handles, input.templateId, isoDate(input.effectiveTo));
  return { id: input.templateId };
}

export async function createOneOffObligation(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = oneOffSchema.parse(raw);
  const id = newId();
  await insertOneOffObligation(handles, {
    id,
    workspaceId: context.workspaceId,
    templateId: null,
    nameSnapshot: input.name,
    dueOn: isoDate(input.dueOn),
    amountPaise: input.amountPaise,
    prioritySnapshot: input.priority,
    status: "open",
    fundingCycleId: null,
    paidEventId: null,
  });
  return { id };
}

export async function listObligationTemplates(handles: DbHandles, workspaceId: string) {
  const snapshot = await loadSnapshot(handles, workspaceId);
  return snapshot.obligationTemplates.map((template) => ({
    ...template,
    amountPaise: snapshot.obligationInstances
      .filter((instance) => instance.templateId === template.id && instance.status === "open")
      .sort((left, right) => left.dueOn.localeCompare(right.dueOn))[0]?.amountPaise ?? null,
  }));
}

export type { ObligationPriority };
