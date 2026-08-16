import { eq } from "drizzle-orm";
import { isoDate, type IsoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import { paise } from "../domain/money/paise.js";
import type { ObligationPriority, ObligationTemplate } from "../domain/ledger/types.js";
import {
  generateObligationInstances,
  parseDueRule,
  type ObligationConfigRow,
} from "../domain/obligations/generate.js";
import { configVersions, obligationInstances, obligationTemplates } from "./schema.js";
import type { SqliteHandles } from "./client.js";
import { withTransaction } from "./tx.js";

function loadTemplates(handles: SqliteHandles, workspaceId: string): ObligationTemplate[] {
  return handles.db
    .select()
    .from(obligationTemplates)
    .where(eq(obligationTemplates.workspaceId, workspaceId))
    .all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      priority: row.priority as ObligationPriority,
      dueRule: parseDueRule(JSON.parse(row.dueRule) as unknown),
      defaultAccountId: row.defaultAccountId,
      loanId: row.loanId,
      effectiveFrom: isoDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo ? isoDate(row.effectiveTo) : null,
    }));
}

function loadExisting(handles: SqliteHandles, workspaceId: string) {
  return handles.db
    .select()
    .from(obligationInstances)
    .where(eq(obligationInstances.workspaceId, workspaceId))
    .all()
    .map((row) => ({
      id: row.id,
      templateId: row.templateId,
      nameSnapshot: row.nameSnapshot,
      dueOn: isoDate(row.dueOn),
      amountPaise: paise(row.amountPaise),
      prioritySnapshot: row.prioritySnapshot as ObligationPriority,
      status: row.status as "open" | "paid" | "skipped",
      fundingCycleId: row.fundingCycleId,
      paidEventId: row.paidEventId,
    }));
}

function loadConfigs(handles: SqliteHandles, workspaceId: string): ObligationConfigRow[] {
  return handles.db
    .select()
    .from(configVersions)
    .where(eq(configVersions.workspaceId, workspaceId))
    .all()
    .map((row) => ({
      key: row.key,
      subjectId: row.subjectId,
      effectiveFrom: isoDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo ? isoDate(row.effectiveTo) : null,
      value: JSON.parse(row.value) as unknown,
    }));
}

/** Persist missing generated instances. Call only from explicit app materialization. */
export function persistGeneratedInstances(
  handles: SqliteHandles,
  workspaceId: string,
  asOf: IsoDate = todayKolkata(),
): number {
  return withTransaction(handles, () => {
    const created = generateObligationInstances({
      templates: loadTemplates(handles, workspaceId),
      existing: loadExisting(handles, workspaceId),
      configs: loadConfigs(handles, workspaceId),
      asOf,
    });
    if (created.length === 0) return 0;

    const insert = handles.sqlite.prepare(`
      INSERT OR IGNORE INTO obligation_instances (
        id, workspace_id, template_id, name_snapshot, due_on, amount_paise,
        priority_snapshot, status, funding_cycle_id, paid_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const instance of created) {
      const result = insert.run(
        instance.id,
        workspaceId,
        instance.templateId,
        instance.nameSnapshot,
        instance.dueOn,
        instance.amountPaise,
        instance.prioritySnapshot,
        instance.status,
        instance.fundingCycleId,
        instance.paidEventId,
      );
      inserted += result.changes;
    }
    return inserted;
  });
}
