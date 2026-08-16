import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import type { IsoDate } from "../domain/calendar/isoDate.js";
import { DomainError, type CardCycleRule } from "../domain/ledger/types.js";
import { parseCardCycleRule } from "../domain/cycle/assign.js";
import { configVersions } from "./schema.js";
import type { SqliteHandles } from "./client.js";

export const CONFIG_CARD_STATEMENT_DAY = "card.statement_day";
export const CONFIG_CARD_DUE_RULE = "card.due_rule";

export function upsertConfig(
  handles: SqliteHandles,
  workspaceId: string,
  input: {
    key: string;
    subjectId: string;
    effectiveFrom: IsoDate;
    value: unknown;
  },
): void {
  const existing = handles.db
    .select()
    .from(configVersions)
    .where(
      and(
        eq(configVersions.workspaceId, workspaceId),
        eq(configVersions.key, input.key),
        eq(configVersions.subjectId, input.subjectId),
      ),
    )
    .all()
    .sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));

  const sameStart = existing.find((row) => row.effectiveFrom === input.effectiveFrom);
  if (sameStart) {
    handles.db
      .update(configVersions)
      .set({ value: JSON.stringify(input.value) })
      .where(eq(configVersions.id, sameStart.id))
      .run();
    return;
  }

  const open = existing.find(
    (row) =>
      row.effectiveFrom < input.effectiveFrom &&
      (row.effectiveTo === null || row.effectiveTo > input.effectiveFrom),
  );
  if (open) {
    handles.db
      .update(configVersions)
      .set({ effectiveTo: input.effectiveFrom })
      .where(eq(configVersions.id, open.id))
      .run();
  }

  handles.db
    .insert(configVersions)
    .values({
      id: newId(),
      workspaceId,
      key: input.key,
      subjectId: input.subjectId,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: null,
      value: JSON.stringify(input.value),
    })
    .run();
}

export function loadConfigValue(
  handles: SqliteHandles,
  workspaceId: string,
  key: string,
  subjectId: string,
  asOf: IsoDate,
): unknown | null {
  const rows = handles.db
    .select()
    .from(configVersions)
    .where(
      and(
        eq(configVersions.workspaceId, workspaceId),
        eq(configVersions.key, key),
        eq(configVersions.subjectId, subjectId),
        lte(configVersions.effectiveFrom, asOf),
        or(isNull(configVersions.effectiveTo), gt(configVersions.effectiveTo, asOf)),
      ),
    )
    .all();

  const current = rows.sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
  if (!current) return null;
  return JSON.parse(current.value) as unknown;
}

export function loadCardRule(
  handles: SqliteHandles,
  workspaceId: string,
  cardId: string,
  asOf: IsoDate,
): CardCycleRule {
  const statement = loadConfigValue(
    handles,
    workspaceId,
    CONFIG_CARD_STATEMENT_DAY,
    cardId,
    asOf,
  );
  const due = loadConfigValue(handles, workspaceId, CONFIG_CARD_DUE_RULE, cardId, asOf);
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

export function writeCardRule(
  handles: SqliteHandles,
  workspaceId: string,
  cardId: string,
  rule: CardCycleRule,
  effectiveFrom: IsoDate,
): void {
  upsertConfig(handles, workspaceId, {
    key: CONFIG_CARD_STATEMENT_DAY,
    subjectId: cardId,
    effectiveFrom,
    value: { statementDay: rule.statementDay },
  });
  upsertConfig(handles, workspaceId, {
    key: CONFIG_CARD_DUE_RULE,
    subjectId: cardId,
    effectiveFrom,
    value: { dueDaysAfterStatement: rule.dueDaysAfterStatement },
  });
}
