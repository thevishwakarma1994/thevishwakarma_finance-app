import { z } from "zod";
import { newId } from "../domain/ids.js";
import { isoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata, utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import { parseCardCycleRule } from "../domain/cycle/assign.js";
import { loadCardRule } from "../db/config.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import {
  findAccount,
  findCard,
  findPerson,
  insertCardWithRule,
  updateCardWithOptionalRule,
} from "../db/catalog.js";

const INITIAL_RULE_FROM = isoDate("2000-01-01");

const createSchema = z.object({
  displayName: z.string().trim().min(1),
  issuer: z.string().trim().min(1),
  mask: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Last 4 digits must be four numbers")
    .nullable()
    .optional(),
  creditLimitPaise: z.number().int().positive().nullable().optional(),
  defaultPaymentAccountId: z.string().min(1).nullable().optional(),
  defaultOwnerPersonId: z.string().min(1).nullable().optional(),
  statementDay: z.number().int().min(1).max(31),
  dueDaysAfterStatement: z.number().int().min(0),
});

const updateSchema = z.object({
  cardId: z.string().min(1),
  displayName: z.string().trim().min(1).optional(),
  issuer: z.string().trim().min(1).optional(),
  mask: z
    .string()
    .trim()
    .regex(/^\d{4}$/, "Last 4 digits must be four numbers")
    .nullable()
    .optional(),
  creditLimitPaise: z.number().int().positive().nullable().optional(),
  defaultPaymentAccountId: z.string().min(1).nullable().optional(),
  defaultOwnerPersonId: z.string().min(1).nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  statementDay: z.number().int().min(1).max(31).optional(),
  dueDaysAfterStatement: z.number().int().min(0).optional(),
  ruleEffectiveFrom: z.string().optional(),
});

async function requireCard(handles: DbHandles, workspaceId: string, cardId: string) {
  const row = await findCard(handles, cardId);
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError("card_not_found", "Credit card not found");
  }
  return row;
}

async function requirePaymentAccount(
  handles: DbHandles,
  workspaceId: string,
  accountId: string | null | undefined,
) {
  if (!accountId) return;
  const row = await findAccount(handles, accountId);
  if (!row || row.workspaceId !== workspaceId || row.status !== "active") {
    throw new DomainError("account_not_found", "Default payment account not found");
  }
}

async function requireOwnerPerson(
  handles: DbHandles,
  workspaceId: string,
  personId: string | null | undefined,
) {
  if (!personId) return;
  const row = await findPerson(handles, personId);
  if (!row || row.workspaceId !== workspaceId || row.status !== "active") {
    throw new DomainError("person_not_found", "Default owner not found");
  }
}

export async function createCard(handles: DbHandles, context: WorkspaceContext, raw: unknown) {
  const input = createSchema.parse(raw);
  await requirePaymentAccount(handles, context.workspaceId, input.defaultPaymentAccountId);
  await requireOwnerPerson(handles, context.workspaceId, input.defaultOwnerPersonId);
  const id = newId();
  const rule = parseCardCycleRule({
    statementDay: input.statementDay,
    dueDaysAfterStatement: input.dueDaysAfterStatement,
  });

  await insertCardWithRule(
    handles,
    {
      id,
      workspaceId: context.workspaceId,
      displayName: input.displayName,
      issuer: input.issuer,
      mask: input.mask ?? null,
      creditLimitPaise: input.creditLimitPaise ?? null,
      defaultPaymentAccountId: input.defaultPaymentAccountId ?? null,
      defaultOwnerPersonId: input.defaultOwnerPersonId ?? null,
      status: "active",
      createdAt: utcNowIso(),
    },
    rule,
    INITIAL_RULE_FROM,
  );

  return { id };
}

export async function updateCard(handles: DbHandles, context: WorkspaceContext, raw: unknown) {
  const input = updateSchema.parse(raw);
  const row = await requireCard(handles, context.workspaceId, input.cardId);
  if (input.defaultPaymentAccountId !== undefined) {
    await requirePaymentAccount(handles, context.workspaceId, input.defaultPaymentAccountId);
  }
  if (input.defaultOwnerPersonId !== undefined) {
    await requireOwnerPerson(handles, context.workspaceId, input.defaultOwnerPersonId);
  }

  const patch: {
    displayName?: string;
    issuer?: string;
    mask?: string | null;
    creditLimitPaise?: number | null;
    defaultPaymentAccountId?: string | null;
    defaultOwnerPersonId?: string | null;
    status?: "active" | "inactive";
  } = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.issuer !== undefined) patch.issuer = input.issuer;
  if (input.mask !== undefined) patch.mask = input.mask;
  if (input.creditLimitPaise !== undefined) patch.creditLimitPaise = input.creditLimitPaise;
  if (input.defaultPaymentAccountId !== undefined) {
    patch.defaultPaymentAccountId = input.defaultPaymentAccountId;
  }
  if (input.defaultOwnerPersonId !== undefined) {
    patch.defaultOwnerPersonId = input.defaultOwnerPersonId;
  }
  if (input.status !== undefined) patch.status = input.status;

  let rule: { next: ReturnType<typeof parseCardCycleRule>; effectiveFrom: ReturnType<typeof isoDate> } | null =
    null;
  if (input.statementDay !== undefined || input.dueDaysAfterStatement !== undefined) {
    const asOf = input.ruleEffectiveFrom ? isoDate(input.ruleEffectiveFrom) : todayKolkata();
    const current = await loadCardRule(handles, context.workspaceId, input.cardId, asOf);
    rule = {
      next: {
        statementDay: input.statementDay ?? current.statementDay,
        dueDaysAfterStatement: input.dueDaysAfterStatement ?? current.dueDaysAfterStatement,
      },
      effectiveFrom: asOf,
    };
  }

  await updateCardWithOptionalRule(handles, input.cardId, context.workspaceId, patch, rule);
  return { id: row.id };
}
