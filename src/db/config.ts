import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import type { IsoDate } from "../domain/calendar/isoDate.js";
import { DomainError, type CardCycleRule } from "../domain/ledger/types.js";
import { parseCardCycleRule } from "../domain/cycle/assign.js";
import type { DbHandles, SqliteHandles } from "./handles.js";
import { anyDb, queryAll, queryRun, tables } from "./exec.js"; 

export const CONFIG_CARD_STATEMENT_DAY = "card.statement_day";
export const CONFIG_CARD_DUE_RULE = "card.due_rule";

function upsertConfigSqlite(
  handles: SqliteHandles,
  workspaceId: string,
  input: {
    key: string;
    subjectId: string;
    effectiveFrom: IsoDate;
    value: unknown;
  },
): void {
  const t = tables(handles);
  const existing = anyDb(handles)
    .select()
    .from(t.configVersions)
    .where(
      and(
        eq(t.configVersions.workspaceId, workspaceId),
        eq(t.configVersions.key, input.key),
        eq(t.configVersions.subjectId, input.subjectId),
      ),
    )
    .all() as Array<{
      id: string;
      effectiveFrom: string;
      effectiveTo: string | null;
    }>;
  existing.sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

  const sameStart = existing.find((row) => row.effectiveFrom === input.effectiveFrom);
  if (sameStart) {
    anyDb(handles)
      .update(t.configVersions)
      .set({ value: JSON.stringify(input.value) })
      .where(eq(t.configVersions.id, sameStart.id))
      .run();
    return;
  }

  const open = existing.find(
    (row) =>
      row.effectiveFrom < input.effectiveFrom &&
      (row.effectiveTo === null || row.effectiveTo > input.effectiveFrom),
  );
  if (open) {
    anyDb(handles)
      .update(t.configVersions)
      .set({ effectiveTo: input.effectiveFrom })
      .where(eq(t.configVersions.id, open.id))
      .run();
  }

  const next = existing.find((row) => row.effectiveFrom > input.effectiveFrom);
  anyDb(handles)
    .insert(t.configVersions)
    .values({
      id: newId(),
      workspaceId,
      key: input.key,
      subjectId: input.subjectId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: next?.effectiveFrom ?? null,
      value: JSON.stringify(input.value),
    })
    .run();
}

export function writeCardRuleSqlite(
  handles: SqliteHandles,
  workspaceId: string,
  cardId: string,
  rule: CardCycleRule,
  effectiveFrom: IsoDate,
): void {
  upsertConfigSqlite(handles, workspaceId, {
    key: CONFIG_CARD_STATEMENT_DAY,
    subjectId: cardId,
    effectiveFrom,
    value: { statementDay: rule.statementDay },
  });
  upsertConfigSqlite(handles, workspaceId, {
    key: CONFIG_CARD_DUE_RULE,
    subjectId: cardId,
    effectiveFrom,
    value: { dueDaysAfterStatement: rule.dueDaysAfterStatement },
  });
}

export { upsertConfigSqlite };

export async function upsertConfig(
  handles: DbHandles,
  workspaceId: string,
  input: {
    key: string;
    subjectId: string;
    effectiveFrom: IsoDate;
    value: unknown;
  },
): Promise<void> {
  if (handles.dialect === "sqlite") {
    upsertConfigSqlite(handles, workspaceId, input);
    return;
  }
  const t = tables(handles);
  const existing = (
    await queryAll<{
      id: string;
      effectiveFrom: string;
      effectiveTo: string | null;
    }>(
      handles,
      anyDb(handles)
        .select()
        .from(t.configVersions)
        .where(
          and(
            eq(t.configVersions.workspaceId, workspaceId),
            eq(t.configVersions.key, input.key),
            eq(t.configVersions.subjectId, input.subjectId),
          ),
        ),
    )
  ).sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

  const sameStart = existing.find((row) => row.effectiveFrom === input.effectiveFrom);
  if (sameStart) {
    await queryRun(
      handles,
      anyDb(handles)
        .update(t.configVersions)
        .set({ value: JSON.stringify(input.value) })
        .where(eq(t.configVersions.id, sameStart.id)),
    );
    return;
  }

  const open = existing.find(
    (row) =>
      row.effectiveFrom < input.effectiveFrom &&
      (row.effectiveTo === null || row.effectiveTo > input.effectiveFrom),
  );
  if (open) {
    await queryRun(
      handles,
      anyDb(handles)
        .update(t.configVersions)
        .set({ effectiveTo: input.effectiveFrom })
        .where(eq(t.configVersions.id, open.id)),
    );
  }

  const next = existing.find((row) => row.effectiveFrom > input.effectiveFrom);
  await queryRun(
    handles,
    anyDb(handles).insert(t.configVersions).values({
      id: newId(),
      workspaceId,
      key: input.key,
      subjectId: input.subjectId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: next?.effectiveFrom ?? null,
      value: JSON.stringify(input.value),
    }),
  );
}

export async function loadConfigValue(
  handles: DbHandles,
  workspaceId: string,
  key: string,
  subjectId: string,
  asOf: IsoDate,
): Promise<unknown | null> {
  const t = tables(handles);
  const rows = await queryAll<{ effectiveFrom: string; value: string }>(
    handles,
    anyDb(handles)
      .select()
      .from(t.configVersions)
      .where(
        and(
          eq(t.configVersions.workspaceId, workspaceId),
          eq(t.configVersions.key, key),
          eq(t.configVersions.subjectId, subjectId),
          lte(t.configVersions.effectiveFrom, asOf),
          or(isNull(t.configVersions.effectiveTo), gt(t.configVersions.effectiveTo, asOf)),
        ),
      ),
  );

  const current = rows.sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
  if (!current) return null;
  return JSON.parse(current.value) as unknown;
}

export async function loadCardRule(
  handles: DbHandles,
  workspaceId: string,
  cardId: string,
  asOf: IsoDate,
): Promise<CardCycleRule> {
  const statement = await loadConfigValue(
    handles,
    workspaceId,
    CONFIG_CARD_STATEMENT_DAY,
    cardId,
    asOf,
  );
  const due = await loadConfigValue(handles, workspaceId, CONFIG_CARD_DUE_RULE, cardId, asOf);
  if (!statement || !due) {
    throw new DomainError("card_rule_missing", "This card has no statement or due rule for that date");
  }
  const statementRecord = statement as { statementDay?: unknown };
  const dueRecord = due as { dueDaysAfterStatement?: unknown };
  return parseCardCycleRule({
    statementDay: statementRecord.statementDay,
    dueDaysAfterStatement: dueRecord.dueDaysAfterStatement,
  });
}

export async function writeCardRule(
  handles: DbHandles,
  workspaceId: string,
  cardId: string,
  rule: CardCycleRule,
  effectiveFrom: IsoDate,
): Promise<void> {
  if (handles.dialect === "sqlite") {
    writeCardRuleSqlite(handles, workspaceId, cardId, rule, effectiveFrom);
    return;
  }
  await upsertConfig(handles, workspaceId, {
    key: CONFIG_CARD_STATEMENT_DAY,
    subjectId: cardId,
    effectiveFrom,
    value: { statementDay: rule.statementDay },
  });
  await upsertConfig(handles, workspaceId, {
    key: CONFIG_CARD_DUE_RULE,
    subjectId: cardId,
    effectiveFrom,
    value: { dueDaysAfterStatement: rule.dueDaysAfterStatement },
  });
}
