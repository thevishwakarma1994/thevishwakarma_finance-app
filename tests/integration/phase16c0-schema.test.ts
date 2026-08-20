import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openMemoryDatabase } from "../../src/db/client.js";
import { openPostgresDatabase } from "../../src/db/pg/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { applyPostgresMigrations, truncatePostgresData } from "../../src/db/pg/migrate.js";
import { anyDb, tables } from "../../src/db/exec.js";
import { newId } from "../../src/domain/ids.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";

const postgresUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const describePg = postgresUrl ? describe : describe.skip;

async function sqliteSetup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  return handles;
}

describe("phase 16c0 transaction_corrections schema (sqlite)", () => {
  let handles: ReturnType<typeof openMemoryDatabase> | undefined;

  afterEach(() => {
    handles?.sqlite.close();
    handles = undefined;
  });

  it("applies the additive migration with an empty table", async () => {
    handles = await sqliteSetup();
    const count = handles.sqlite.prepare("SELECT COUNT(*) AS n FROM transaction_corrections").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("enforces distinct event ids and unique targets", async () => {
    handles = await sqliteSetup();
    const workspaceId = await getSoleWorkspaceId(handles);
    const eventIds = [newId(), newId(), newId(), newId()];
    for (const id of eventIds) {
      handles.sqlite
        .prepare(
          `INSERT INTO financial_events (id, workspace_id, meaning, occurred_on, captured_at, amount_paise)
           VALUES (?, ?, 'spend_account', '2026-08-01', '2026-08-01T00:00:00.000Z', 100)`,
        )
        .run(id, workspaceId);
    }
    const insert = handles.sqlite.prepare(`
      INSERT INTO transaction_corrections (
        id, workspace_id, command_id, root_event_id, target_event_id, reversal_event_id, replacement_event_id,
        corrected_on, captured_at, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-20', '2026-08-20T00:00:00.000Z', null)
    `);
    insert.run(newId(), workspaceId, "cmd-a", eventIds[0], eventIds[0], eventIds[1], eventIds[2]);
    expect(() => insert.run(newId(), workspaceId, "cmd-b", eventIds[0], eventIds[0], eventIds[2], eventIds[3])).toThrow();
    expect(() =>
      insert.run(newId(), workspaceId, "cmd-c", eventIds[3], eventIds[1], eventIds[1], eventIds[3]),
    ).toThrow();
  });
});

describePg("phase 16c0 transaction_corrections schema (postgres)", { timeout: 60_000 }, () => {
  let handles: ReturnType<typeof openPostgresDatabase> | undefined;

  afterEach(async () => {
    if (!handles) return;
    await truncatePostgresData(handles);
    await closeDatabase(handles);
    handles = undefined;
  });

  it("applies the additive migration and unique target constraint", async () => {
    handles = openPostgresDatabase(postgresUrl);
    await applyPostgresMigrations(handles);
    await truncatePostgresData(handles);
    const workspaceId = newId();
    const t = tables(handles);
    const db = anyDb(handles);
    await db.insert(t.workspaces).values({ id: workspaceId, name: "pg-16c0", createdAt: utcNowIso() });
    const eventIds = [newId(), newId(), newId()];
    for (const id of eventIds) {
      await db.insert(t.financialEvents).values({
        id,
        workspaceId,
        meaning: "spend_account",
        occurredOn: "2026-08-01",
        capturedAt: "2026-08-01T00:00:00.000Z",
        amountPaise: 100,
        accountId: null,
        creditCardId: null,
        billingCycleId: null,
        obligationInstanceId: null,
        categoryId: null,
        channel: null,
        merchant: null,
        notes: null,
        reversalOfEventId: null,
      });
    }
    await db.insert(t.transactionCorrections).values({
      id: newId(),
      workspaceId,
      commandId: "cmd-a",
      rootEventId: eventIds[0]!,
      targetEventId: eventIds[0]!,
      reversalEventId: eventIds[1]!,
      replacementEventId: eventIds[2]!,
      correctedOn: "2026-08-20",
      capturedAt: "2026-08-20T00:00:00.000Z",
      reason: null,
    });
    await expect(
      db.insert(t.transactionCorrections).values({
        id: newId(),
        workspaceId,
        commandId: "cmd-b",
        rootEventId: eventIds[0]!,
        targetEventId: eventIds[0]!,
        reversalEventId: eventIds[2]!,
        replacementEventId: eventIds[1]!,
        correctedOn: "2026-08-20",
        capturedAt: "2026-08-20T00:00:00.000Z",
        reason: null,
      }),
    ).rejects.toThrow();
  });
});
