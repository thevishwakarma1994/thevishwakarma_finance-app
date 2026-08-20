import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { openDatabase, openMemoryDatabase, type DbHandles, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { anyDb, queryAll, tables } from "../../src/db/exec.js";
import { home } from "../../src/db/reads.js";
import { applySalaryPolicy, salarySchedule } from "../../src/app/salaryPolicy.js";

const AUG = {
  expectedAmountPaise: 7_920_000,
  windowStartDay: 4,
  typicalDay: 5,
  windowEndDay: 8,
  effectiveFrom: "2026-08-01",
};

async function seedSqlite() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  return { handles, workspaceId };
}

async function fundingRows(handles: DbHandles, workspaceId: string) {
  const t = tables(handles);
  const rows = await queryAll<Record<string, unknown>>(
    handles,
    anyDb(handles).select().from(t.fundingCycles).where(eq(t.fundingCycles.workspaceId, workspaceId)),
  );
  return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
}

describe("phase 16b salary schedule GET is read-only", () => {
  const contexts: SqliteHandles[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not insert or update funding_cycles on repeated GET", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    const before = await fundingRows(ctx.handles, ctx.workspaceId);
    expect(before).toHaveLength(0);

    const first = await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05"));
    expect(first.nextExpected?.month).toBe(8);
    expect(first.nextExpected?.fundingCycleId).toBeNull();
    expect(first.receivableCycles.length).toBeGreaterThan(0);

    await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05"));
    await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2026-08-05"));
    expect(await fundingRows(ctx.handles, ctx.workspaceId)).toEqual(before);
  });

  it("keeps arbitrary and future asOf reads pure", async () => {
    const ctx = await seedSqlite();
    contexts.push(ctx.handles);
    await applySalaryPolicy(ctx.handles, { workspaceId: ctx.workspaceId }, AUG);
    const before = await fundingRows(ctx.handles, ctx.workspaceId);

    await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2024-01-15"));
    await salarySchedule(ctx.handles, { workspaceId: ctx.workspaceId }, isoDate("2028-12-01"));
    await home(ctx.handles, ctx.workspaceId, isoDate("2026-08-05"));
    await home(ctx.handles, ctx.workspaceId, isoDate("2028-01-01"));

    expect(await fundingRows(ctx.handles, ctx.workspaceId)).toEqual(before);
    expect((await loadSnapshot(ctx.handles, ctx.workspaceId)).incomePolicies).toHaveLength(1);
  });

  it("creates zero rows under concurrent reads", async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp-salary-read-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "ledger.sqlite");
    const writer = openDatabase(dbPath);
    contexts.push(writer);
    await applyMigrations(writer);
    const workspaceId = await getSoleWorkspaceId(writer);
    await applySalaryPolicy(writer, { workspaceId }, AUG);
    const before = await fundingRows(writer, workspaceId);

    const readers = [openDatabase(dbPath), openDatabase(dbPath), openDatabase(dbPath)];
    contexts.push(...readers);
    await Promise.all(
      readers.flatMap((handles) => [
        salarySchedule(handles, { workspaceId }, isoDate("2026-08-05")),
        salarySchedule(handles, { workspaceId }, isoDate("2026-10-02")),
        salarySchedule(handles, { workspaceId }, isoDate("2028-01-01")),
      ]),
    );

    expect(await fundingRows(writer, workspaceId)).toEqual(before);
  });
});
