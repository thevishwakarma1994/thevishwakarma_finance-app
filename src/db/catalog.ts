import { and, eq, isNull } from "drizzle-orm";
import type { DbHandles } from "./handles.js";
import { anyDb, queryAll, queryGet, queryRun, tables } from "./exec.js"; 
import { withPostgresTransaction, withSqliteTransaction } from "./tx.js";
import {
  upsertConfig,
  upsertConfigSqlite,
  writeCardRule,
  writeCardRuleSqlite,
} from "./config.js";
import {
  CONFIG_OBLIGATION_AMOUNT,
  CONFIG_OBLIGATION_PRIORITY,
} from "../domain/obligations/generate.js";
import type { IsoDate } from "../domain/calendar/isoDate.js";
import type { CardCycleRule } from "../domain/ledger/types.js";

export async function findAccount(handles: DbHandles, id: string) {
  const t = tables(handles);
  return queryGet(handles, anyDb(handles).select().from(t.accounts).where(eq(t.accounts.id, id)));
}

export async function findPerson(handles: DbHandles, id: string) {
  const t = tables(handles);
  return queryGet(handles, anyDb(handles).select().from(t.people).where(eq(t.people.id, id)));
}

export async function findCategory(handles: DbHandles, id: string) {
  const t = tables(handles);
  return queryGet(handles, anyDb(handles).select().from(t.categories).where(eq(t.categories.id, id)));
}

export async function findCard(handles: DbHandles, id: string) {
  const t = tables(handles);
  return queryGet(handles, anyDb(handles).select().from(t.creditCards).where(eq(t.creditCards.id, id)));
}

export async function findObligationTemplate(handles: DbHandles, id: string) {
  const t = tables(handles);
  return queryGet(
    handles,
    anyDb(handles).select().from(t.obligationTemplates).where(eq(t.obligationTemplates.id, id)),
  );
}

export async function listAccountsInWorkspace(handles: DbHandles, workspaceId: string) {
  const t = tables(handles);
  return queryAll(handles, anyDb(handles).select().from(t.accounts).where(eq(t.accounts.workspaceId, workspaceId)));
}

export async function listSiblingCategories(
  handles: DbHandles,
  workspaceId: string,
  parentId: string | null,
) {
  const t = tables(handles);
  return queryAll(
    handles,
    anyDb(handles)
      .select()
      .from(t.categories)
      .where(
        parentId
          ? and(eq(t.categories.workspaceId, workspaceId), eq(t.categories.parentId, parentId))
          : and(eq(t.categories.workspaceId, workspaceId), isNull(t.categories.parentId)),
      ),
  );
}

async function clearPrimarySalary(handles: DbHandles, workspaceId: string): Promise<void> {
  const rows = await listAccountsInWorkspace(handles, workspaceId);
  const t = tables(handles);
  for (const row of rows) {
    if (row.isPrimarySalary === 1) {
      await queryRun(
        handles,
        anyDb(handles).update(t.accounts).set({ isPrimarySalary: 0 }).where(eq(t.accounts.id, row.id)),
      );
    }
  }
}

export async function insertAccount(
  handles: DbHandles,
  values: {
    id: string;
    workspaceId: string;
    kind: string;
    displayName: string;
    mask: string | null;
    isPrimarySalary: number;
    status: string;
    createdAt: string;
  },
  clearPrimary: boolean,
): Promise<void> {
  if (handles.dialect === "sqlite") {
    withSqliteTransaction(handles, () => {
      const t = tables(handles);
      if (clearPrimary) {
        const rows = anyDb(handles).select().from(t.accounts).where(eq(t.accounts.workspaceId, values.workspaceId)).all();
        for (const row of rows) {
          if (row.isPrimarySalary === 1) {
            anyDb(handles).update(t.accounts).set({ isPrimarySalary: 0 }).where(eq(t.accounts.id, row.id)).run();
          }
        }
      }
      anyDb(handles).insert(t.accounts).values(values).run();
    });
    return;
  }
  await withPostgresTransaction(handles, async (tx) => {
    if (clearPrimary) await clearPrimarySalary(tx, values.workspaceId);
    const t = tables(tx);
    await anyDb(tx).insert(t.accounts).values(values);
  });
}

export async function updateAccountRow(
  handles: DbHandles,
  accountId: string,
  workspaceId: string,
  patch: { displayName?: string; isPrimarySalary?: number; status?: "active" | "archived" },
  clearPrimary: boolean,
): Promise<void> {
  if (handles.dialect === "sqlite") {
    withSqliteTransaction(handles, () => {
      const t = tables(handles);
      if (clearPrimary) {
        const rows = anyDb(handles).select().from(t.accounts).where(eq(t.accounts.workspaceId, workspaceId)).all();
        for (const row of rows) {
          if (row.isPrimarySalary === 1) {
            anyDb(handles).update(t.accounts).set({ isPrimarySalary: 0 }).where(eq(t.accounts.id, row.id)).run();
          }
        }
      }
      if (Object.keys(patch).length > 0) {
        anyDb(handles).update(t.accounts).set(patch).where(eq(t.accounts.id, accountId)).run();
      }
    });
    return;
  }
  await withPostgresTransaction(handles, async (tx) => {
    if (clearPrimary) await clearPrimarySalary(tx, workspaceId);
    if (Object.keys(patch).length > 0) {
      const t = tables(tx);
      await anyDb(tx).update(t.accounts).set(patch).where(eq(t.accounts.id, accountId));
    }
  });
}

export async function insertPersonRow(
  handles: DbHandles,
  values: {
    id: string;
    workspaceId: string;
    name: string;
    notes: string | null;
    status: string;
    createdAt: string;
  },
): Promise<void> {
  const t = tables(handles);
  await queryRun(handles, anyDb(handles).insert(t.people).values(values));
}

export async function updatePersonRow(
  handles: DbHandles,
  personId: string,
  patch: { name?: string; notes?: string | null; status?: "active" | "archived" },
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const t = tables(handles);
  await queryRun(handles, anyDb(handles).update(t.people).set(patch).where(eq(t.people.id, personId)));
}

export async function insertCategoryRow(
  handles: DbHandles,
  values: {
    id: string;
    workspaceId: string;
    parentId: string | null;
    name: string;
    archivedAt: string | null;
  },
): Promise<void> {
  const t = tables(handles);
  await queryRun(handles, anyDb(handles).insert(t.categories).values(values));
}

export async function updateCategoryRow(
  handles: DbHandles,
  categoryId: string,
  patch: { name: string; archivedAt: string | null },
): Promise<void> {
  const t = tables(handles);
  await queryRun(handles, anyDb(handles).update(t.categories).set(patch).where(eq(t.categories.id, categoryId)));
}

export async function insertCardWithRule(
  handles: DbHandles,
  values: {
    id: string;
    workspaceId: string;
    displayName: string;
    issuer: string;
    mask: string | null;
    creditLimitPaise: number | null;
    defaultPaymentAccountId: string | null;
    defaultOwnerPersonId: string | null;
    status: string;
    createdAt: string;
  },
  rule: CardCycleRule,
  effectiveFrom: IsoDate,
): Promise<void> {
  if (handles.dialect === "sqlite") {
    withSqliteTransaction(handles, () => {
      const t = tables(handles);
      anyDb(handles).insert(t.creditCards).values(values).run();
      writeCardRuleSqlite(handles, values.workspaceId, values.id, rule, effectiveFrom);
    });
    return;
  }
  await withPostgresTransaction(handles, async (tx) => {
    const t = tables(tx);
    await anyDb(tx).insert(t.creditCards).values(values);
    await writeCardRule(tx, values.workspaceId, values.id, rule, effectiveFrom);
  });
}

export async function updateCardWithOptionalRule(
  handles: DbHandles,
  cardId: string,
  workspaceId: string,
  patch: {
    displayName?: string;
    issuer?: string;
    mask?: string | null;
    creditLimitPaise?: number | null;
    defaultPaymentAccountId?: string | null;
    defaultOwnerPersonId?: string | null;
    status?: "active" | "inactive";
  },
  rule:
    | {
        next: CardCycleRule;
        effectiveFrom: IsoDate;
      }
    | null,
): Promise<void> {
  if (handles.dialect === "sqlite") {
    withSqliteTransaction(handles, () => {
      const t = tables(handles);
      if (Object.keys(patch).length > 0) {
        anyDb(handles).update(t.creditCards).set(patch).where(eq(t.creditCards.id, cardId)).run();
      }
      if (rule) {
        writeCardRuleSqlite(handles, workspaceId, cardId, rule.next, rule.effectiveFrom);
      }
    });
    return;
  }
  await withPostgresTransaction(handles, async (tx) => {
    const t = tables(tx);
    if (Object.keys(patch).length > 0) {
      await anyDb(tx).update(t.creditCards).set(patch).where(eq(t.creditCards.id, cardId));
    }
    if (rule) {
      await writeCardRule(tx, workspaceId, cardId, rule.next, rule.effectiveFrom);
    }
  });
}

export async function insertObligationTemplateWithConfig(
  handles: DbHandles,
  values: {
    id: string;
    workspaceId: string;
    name: string;
    priority: string;
    dueRule: string;
    defaultAccountId: string | null;
    loanId: string | null;
    effectiveFrom: IsoDate;
    effectiveTo: null;
  },
  amountPaise: number,
  priority: string,
): Promise<void> {
  if (handles.dialect === "sqlite") {
    withSqliteTransaction(handles, () => {
      const t = tables(handles);
      anyDb(handles).insert(t.obligationTemplates).values(values).run();
      upsertConfigSqlite(handles, values.workspaceId, {
        key: CONFIG_OBLIGATION_AMOUNT,
        subjectId: values.id,
        effectiveFrom: values.effectiveFrom,
        value: { amountPaise },
      });
      upsertConfigSqlite(handles, values.workspaceId, {
        key: CONFIG_OBLIGATION_PRIORITY,
        subjectId: values.id,
        effectiveFrom: values.effectiveFrom,
        value: { priority },
      });
    });
    return;
  }
  await withPostgresTransaction(handles, async (tx) => {
    const t = tables(tx);
    await anyDb(tx).insert(t.obligationTemplates).values(values);
    await upsertConfig(tx, values.workspaceId, {
      key: CONFIG_OBLIGATION_AMOUNT,
      subjectId: values.id,
      effectiveFrom: values.effectiveFrom,
      value: { amountPaise },
    });
    await upsertConfig(tx, values.workspaceId, {
      key: CONFIG_OBLIGATION_PRIORITY,
      subjectId: values.id,
      effectiveFrom: values.effectiveFrom,
      value: { priority },
    });
  });
}

export async function changeObligationTemplate(
  handles: DbHandles,
  workspaceId: string,
  templateId: string,
  effectiveFrom: IsoDate,
  input: { name?: string; amountPaise?: number; priority?: string },
): Promise<void> {
  if (handles.dialect === "sqlite") {
    withSqliteTransaction(handles, () => {
      const t = tables(handles);
      if (input.name) {
        anyDb(handles).update(t.obligationTemplates).set({ name: input.name }).where(eq(t.obligationTemplates.id, templateId)).run();
      }
      if (input.amountPaise !== undefined) {
        upsertConfigSqlite(handles, workspaceId, {
          key: CONFIG_OBLIGATION_AMOUNT,
          subjectId: templateId,
          effectiveFrom,
          value: { amountPaise: input.amountPaise },
        });
      }
      if (input.priority) {
        upsertConfigSqlite(handles, workspaceId, {
          key: CONFIG_OBLIGATION_PRIORITY,
          subjectId: templateId,
          effectiveFrom,
          value: { priority: input.priority },
        });
      }
    });
    return;
  }
  await withPostgresTransaction(handles, async (tx) => {
    const t = tables(tx);
    if (input.name) {
      await tx.db
        .update(t.obligationTemplates)
        .set({ name: input.name })
        .where(eq(t.obligationTemplates.id, templateId));
    }
    if (input.amountPaise !== undefined) {
      await upsertConfig(tx, workspaceId, {
        key: CONFIG_OBLIGATION_AMOUNT,
        subjectId: templateId,
        effectiveFrom,
        value: { amountPaise: input.amountPaise },
      });
    }
    if (input.priority) {
      await upsertConfig(tx, workspaceId, {
        key: CONFIG_OBLIGATION_PRIORITY,
        subjectId: templateId,
        effectiveFrom,
        value: { priority: input.priority },
      });
    }
  });
}

export async function archiveObligationTemplateRow(
  handles: DbHandles,
  templateId: string,
  effectiveTo: IsoDate,
): Promise<void> {
  const t = tables(handles);
  await queryRun(
    handles,
    anyDb(handles).update(t.obligationTemplates).set({ effectiveTo }).where(eq(t.obligationTemplates.id, templateId)),
  );
}

export async function insertOneOffObligation(
  handles: DbHandles,
  values: {
    id: string;
    workspaceId: string;
    templateId: null;
    nameSnapshot: string;
    dueOn: IsoDate;
    amountPaise: number;
    prioritySnapshot: string;
    status: "open";
    fundingCycleId: null;
    paidEventId: null;
  },
): Promise<void> {
  const t = tables(handles);
  await queryRun(handles, anyDb(handles).insert(t.obligationInstances).values(values));
}
