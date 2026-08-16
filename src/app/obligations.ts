import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { newId } from "../domain/ids.js";
import { DomainError, type ObligationPriority } from "../domain/ledger/types.js";
import {
  CONFIG_OBLIGATION_AMOUNT,
  CONFIG_OBLIGATION_PRIORITY,
  parseDueRule,
} from "../domain/obligations/generate.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { ensureObligationInstances } from "./ensureObligationInstances.js";
import { upsertConfig } from "../db/config.js";
import { obligationInstances, obligationTemplates } from "../db/schema.js";
import { eq } from "drizzle-orm";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { withTransaction } from "../db/tx.js";

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

export function createObligationTemplate(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = createTemplateSchema.parse(raw);
  parseDueRule({ dayOfMonth: input.dayOfMonth });
  if (input.defaultAccountId) {
    assertWorkspaceOwned(handles, context.workspaceId, [
      { type: "account", id: input.defaultAccountId },
    ]);
  }
  const id = newId();
  const effectiveFrom = isoDate(input.effectiveFrom);
  withTransaction(handles, () => {
    handles.db
      .insert(obligationTemplates)
      .values({
        id,
        workspaceId: context.workspaceId,
        name: input.name,
        priority: input.priority,
        dueRule: JSON.stringify({ dayOfMonth: input.dayOfMonth }),
        defaultAccountId: input.defaultAccountId ?? null,
        loanId: null,
        effectiveFrom,
        effectiveTo: null,
      })
      .run();
    upsertConfig(handles, context.workspaceId, {
      key: CONFIG_OBLIGATION_AMOUNT,
      subjectId: id,
      effectiveFrom,
      value: { amountPaise: input.amountPaise },
    });
    upsertConfig(handles, context.workspaceId, {
      key: CONFIG_OBLIGATION_PRIORITY,
      subjectId: id,
      effectiveFrom,
      value: { priority: input.priority },
    });
  });
  ensureObligationInstances(handles, context.workspaceId, effectiveFrom);
  return { id };
}

export function changeObligationFrom(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = changeFromSchema.parse(raw);
  const effectiveFrom = isoDate(input.effectiveFrom);
  const existing = handles.db
    .select()
    .from(obligationTemplates)
    .where(eq(obligationTemplates.id, input.templateId))
    .get();
  if (!existing || existing.workspaceId !== context.workspaceId) {
    throw new DomainError("obligation_template_not_found", "Obligation template not found");
  }
  withTransaction(handles, () => {
    if (input.name) {
      handles.db
        .update(obligationTemplates)
        .set({ name: input.name })
        .where(eq(obligationTemplates.id, input.templateId))
        .run();
    }
    if (input.amountPaise !== undefined) {
      upsertConfig(handles, context.workspaceId, {
        key: CONFIG_OBLIGATION_AMOUNT,
        subjectId: input.templateId,
        effectiveFrom,
        value: { amountPaise: input.amountPaise },
      });
    }
    if (input.priority) {
      upsertConfig(handles, context.workspaceId, {
        key: CONFIG_OBLIGATION_PRIORITY,
        subjectId: input.templateId,
        effectiveFrom,
        value: { priority: input.priority },
      });
    }
  });
  ensureObligationInstances(handles, context.workspaceId, effectiveFrom);
  return { id: input.templateId };
}

export function archiveObligationTemplate(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = archiveSchema.parse(raw);
  const existing = handles.db
    .select()
    .from(obligationTemplates)
    .where(eq(obligationTemplates.id, input.templateId))
    .get();
  if (!existing || existing.workspaceId !== context.workspaceId) {
    throw new DomainError("obligation_template_not_found", "Obligation template not found");
  }
  handles.db
    .update(obligationTemplates)
    .set({ effectiveTo: isoDate(input.effectiveTo) })
    .where(eq(obligationTemplates.id, input.templateId))
    .run();
  return { id: input.templateId };
}

export function createOneOffObligation(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = oneOffSchema.parse(raw);
  const id = newId();
  handles.db
    .insert(obligationInstances)
    .values({
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
    })
    .run();
  return { id };
}

export function listObligationTemplates(handles: SqliteHandles, workspaceId: string) {
  const snapshot = loadSnapshot(handles, workspaceId);
  return snapshot.obligationTemplates.map((template) => ({
    ...template,
    amountPaise: snapshot.obligationInstances
      .filter((instance) => instance.templateId === template.id && instance.status === "open")
      .sort((left, right) => left.dueOn.localeCompare(right.dueOn))[0]?.amountPaise ?? null,
  }));
}

export type { ObligationPriority };
