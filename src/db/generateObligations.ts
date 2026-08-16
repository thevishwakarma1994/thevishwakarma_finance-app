import { eq } from "drizzle-orm";
import { isoDate, type IsoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import type { ObligationPriority, ObligationTemplate } from "../domain/ledger/types.js";
import {
  generateObligationInstances,
  parseDueRule,
  type ObligationConfigRow,
} from "../domain/obligations/generate.js";
import type { DbHandles, SqliteHandles } from "./handles.js";
import { anyDb, queryAll, tables } from "./exec.js"; 
import { withPostgresTransaction, withSqliteTransaction } from "./tx.js";
import { fromStoredPaise } from "./storedPaise.js";

type TemplateRow = {
  id: string;
  name: string;
  priority: string;
  dueRule: string;
  defaultAccountId: string | null;
  loanId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
};

type InstanceRow = {
  id: string;
  templateId: string | null;
  nameSnapshot: string;
  dueOn: string;
  amountPaise: number;
  prioritySnapshot: string;
  status: string;
  fundingCycleId: string | null;
  paidEventId: string | null;
};

type ConfigRow = {
  key: string;
  subjectId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  value: string;
};

function mapTemplates(rows: TemplateRow[]): ObligationTemplate[] {
  return rows.map((row) => ({
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

function mapExisting(rows: InstanceRow[]) {
  return rows.map((row) => ({
    id: row.id,
    templateId: row.templateId,
    nameSnapshot: row.nameSnapshot,
    dueOn: isoDate(row.dueOn),
    amountPaise: fromStoredPaise(row.amountPaise),
    prioritySnapshot: row.prioritySnapshot as ObligationPriority,
    status: row.status as "open" | "paid" | "skipped",
    fundingCycleId: row.fundingCycleId,
    paidEventId: row.paidEventId,
  }));
}

function mapConfigs(rows: ConfigRow[]): ObligationConfigRow[] {
  return rows.map((row) => ({
    key: row.key,
    subjectId: row.subjectId,
    effectiveFrom: isoDate(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? isoDate(row.effectiveTo) : null,
    value: JSON.parse(row.value) as unknown,
  }));
}

function loadTemplatesSqlite(handles: SqliteHandles, workspaceId: string): ObligationTemplate[] {
  const t = tables(handles);
  return mapTemplates(
    anyDb(handles).select().from(t.obligationTemplates).where(eq(t.obligationTemplates.workspaceId, workspaceId)).all(),
  );
}

function loadExistingSqlite(handles: SqliteHandles, workspaceId: string) {
  const t = tables(handles);
  return mapExisting(
    anyDb(handles).select().from(t.obligationInstances).where(eq(t.obligationInstances.workspaceId, workspaceId)).all(),
  );
}

function loadConfigsSqlite(handles: SqliteHandles, workspaceId: string): ObligationConfigRow[] {
  const t = tables(handles);
  return mapConfigs(
    anyDb(handles).select().from(t.configVersions).where(eq(t.configVersions.workspaceId, workspaceId)).all(),
  );
}

async function loadTemplates(handles: DbHandles, workspaceId: string): Promise<ObligationTemplate[]> {
  const t = tables(handles);
  return mapTemplates(
    await queryAll(
      handles,
      anyDb(handles).select().from(t.obligationTemplates).where(eq(t.obligationTemplates.workspaceId, workspaceId)),
    ),
  );
}

async function loadExisting(handles: DbHandles, workspaceId: string) {
  const t = tables(handles);
  return mapExisting(
    await queryAll(
      handles,
      anyDb(handles).select().from(t.obligationInstances).where(eq(t.obligationInstances.workspaceId, workspaceId)),
    ),
  );
}

async function loadConfigs(handles: DbHandles, workspaceId: string): Promise<ObligationConfigRow[]> {
  const t = tables(handles);
  return mapConfigs(
    await queryAll(
      handles,
      anyDb(handles).select().from(t.configVersions).where(eq(t.configVersions.workspaceId, workspaceId)),
    ),
  );
}

function insertGeneratedSqlite(
  handles: SqliteHandles,
  workspaceId: string,
  created: ReturnType<typeof generateObligationInstances>,
): number {
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
}

/** Persist missing generated instances. Call only from explicit app materialization. */
export async function persistGeneratedInstances(
  handles: DbHandles,
  workspaceId: string,
  asOf: IsoDate = todayKolkata(),
): Promise<number> {
  if (handles.dialect === "sqlite") {
    return withSqliteTransaction(handles, () => {
      const created = generateObligationInstances({
        templates: loadTemplatesSqlite(handles, workspaceId),
        existing: loadExistingSqlite(handles, workspaceId),
        configs: loadConfigsSqlite(handles, workspaceId),
        asOf,
      });
      return insertGeneratedSqlite(handles, workspaceId, created);
    });
  }

  return withPostgresTransaction(handles, async (tx) => {
    const existingBefore = await loadExisting(tx, workspaceId);
    const created = generateObligationInstances({
      templates: await loadTemplates(tx, workspaceId),
      existing: existingBefore,
      configs: await loadConfigs(tx, workspaceId),
      asOf,
    });
    if (created.length === 0) return 0;
    const t = tables(tx);
    await anyDb(tx)
      .insert(t.obligationInstances)
      .values(
        created.map((instance) => ({
          id: instance.id,
          workspaceId,
          templateId: instance.templateId,
          nameSnapshot: instance.nameSnapshot,
          dueOn: instance.dueOn,
          amountPaise: instance.amountPaise,
          prioritySnapshot: instance.prioritySnapshot,
          status: instance.status,
          fundingCycleId: instance.fundingCycleId,
          paidEventId: instance.paidEventId,
        })),
      )
      .onConflictDoNothing();
    const existingAfter = await loadExisting(tx, workspaceId);
    return existingAfter.length - existingBefore.length;
  });
}
