import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DbHandles, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId, LEGACY_WORKSPACE_NAME } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { applyOpeningCard } from "../../src/app/openingCard.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { createCard } from "../../src/app/cards.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";
import { newId } from "../../src/domain/ids.js";
import { anyDb, tables } from "../../src/db/exec.js";
import { openPostgresDatabase } from "../../src/db/pg/client.js";
import { applyPostgresMigrations, truncatePostgresData } from "../../src/db/pg/migrate.js";

const capturedAt = "2026-08-16T10:00:00.000Z";
const postgresUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const describePg = postgresUrl ? describe : describe.skip;

function openingPayload(commandId: string, creditCardId: string) {
  return {
    commandId,
    occurredOn: "2026-08-05",
    capturedAt,
    creditCardId,
    amountPaise: 20_000_00,
  };
}

function isDomain(error: unknown, code: string): boolean {
  return error instanceof DomainError && error.code === code;
}

async function seedCard(handles: DbHandles) {
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfcId = snapshot.accounts.find((account) => account.displayName === "HDFC")!.id;
  const groceryId = snapshot.categories.find((category) => category.name === "Grocery")!.id;
  const card = await createCard(handles, { workspaceId }, {
    displayName: "Amex",
    issuer: "Amex",
    mask: "1001",
    statementDay: 10,
    dueDaysAfterStatement: 20,
    defaultPaymentAccountId: hdfcId,
  });
  return { workspaceId, hdfcId, groceryId, cardId: card.id };
}

function assertExactlyOneOpening(handles: Awaited<ReturnType<typeof loadSnapshot>>, cardId: string) {
  const openings = handles.events.filter(
    (event) => event.meaning === "apply_opening_card_position" && event.creditCardId === cardId,
  );
  expect(openings).toHaveLength(1);
  const cycles = handles.billingCycles.filter((cycle) => cycle.creditCardId === cardId);
  expect(cycles).toHaveLength(1);
  expect(openings[0]!.billingCycleId).toBe(cycles[0]!.id);
}

async function assertDoubleOpeningRace(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  cardId: string,
) {
  const results = await Promise.allSettled([
    applyOpeningCard(left, { workspaceId }, openingPayload("cmd-open-a", cardId)),
    applyOpeningCard(right, { workspaceId }, openingPayload("cmd-open-b", cardId)),
  ]);
  const wins = results.filter((result) => result.status === "fulfilled");
  const losses = results.filter((result) => result.status === "rejected");
  expect(wins).toHaveLength(1);
  expect(losses).toHaveLength(1);
  const reason = (losses[0] as PromiseRejectedResult).reason;
  expect(
    isDomain(reason, "already_exists") || isDomain(reason, "invalid_opening"),
  ).toBe(true);

  const snapshot = await loadSnapshot(left, workspaceId);
  assertExactlyOneOpening(snapshot, cardId);
}

async function assertOpeningVsSpendRace(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  cardId: string,
  groceryId: string,
) {
  const results = await Promise.allSettled([
    applyOpeningCard(left, { workspaceId }, openingPayload("cmd-open-race", cardId)),
    recordCardSpend(right, { workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: cardId,
      allocations: [{ categoryId: groceryId, amountPaise: 1_000_00 }],
      commit: true,
    }),
  ]);
  const opening = results[0]!;
  const spend = results[1]!;
  expect(spend.status).toBe("fulfilled");

  const snapshot = await loadSnapshot(left, workspaceId);
  const openingEvents = snapshot.events.filter(
    (event) => event.meaning === "apply_opening_card_position" && event.creditCardId === cardId,
  );
  const spendEvents = snapshot.events.filter(
    (event) => event.meaning === "spend_card" && event.creditCardId === cardId,
  );
  expect(spendEvents).toHaveLength(1);

  if (opening.status === "fulfilled") {
    // Opening took the card lock first; spend then proceeds under normal rules.
    expect(openingEvents).toHaveLength(1);
  } else {
    // Spend took the card lock first; opening must refuse the pre-lifecycle lock.
    expect(isDomain(opening.reason, "invalid_opening")).toBe(true);
    expect(openingEvents).toHaveLength(0);
  }
}

describe("phase 16a card-write serialization (sqlite two connections)", () => {
  const cleanup: Array<{ handles: SqliteHandles[]; dir: string }> = [];

  afterEach(async () => {
    for (const item of cleanup.splice(0)) {
      for (const handles of item.handles) handles.sqlite.close();
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
  });

  async function dualSqlite() {
    const dir = fs.mkdtempSync(path.join(process.cwd(), "tmp-card-lock-"));
    const dbPath = path.join(dir, "ledger.sqlite");
    const a = openDatabase(dbPath);
    await applyMigrations(a);
    const b = openDatabase(dbPath);
    cleanup.push({ handles: [a, b], dir });
    const seeded = await seedCard(a);
    return { a, b, ...seeded };
  }

  it("rejects a concurrent second base opening", async () => {
    const ctx = await dualSqlite();
    await assertDoubleOpeningRace(ctx.a, ctx.b, ctx.workspaceId, ctx.cardId);
  });

  it("serializes opening vs real card spend", async () => {
    const ctx = await dualSqlite();
    await assertOpeningVsSpendRace(ctx.a, ctx.b, ctx.workspaceId, ctx.cardId, ctx.groceryId);
  });
});

describePg("phase 16a card-write serialization (postgres)", { timeout: 120_000 }, () => {
  let handles: ReturnType<typeof openPostgresDatabase> | undefined;

  afterEach(async () => {
    if (!handles) return;
    await truncatePostgresData(handles);
    await closeDatabase(handles);
    handles = undefined;
  });

  async function setupPg() {
    handles = openPostgresDatabase(postgresUrl);
    await applyPostgresMigrations(handles);
    await truncatePostgresData(handles);
    const workspaceId = newId();
    const now = utcNowIso();
    const t = tables(handles);
    const db = anyDb(handles);
    await db.insert(t.workspaces).values({
      id: workspaceId,
      name: LEGACY_WORKSPACE_NAME,
      createdAt: now,
    });
    await db.insert(t.accounts).values({
      id: newId(),
      workspaceId,
      kind: "bank",
      displayName: "HDFC",
      mask: "2581",
      isPrimarySalary: 1,
      status: "active",
      createdAt: now,
    });
    await db.insert(t.categories).values({
      id: newId(),
      workspaceId,
      parentId: null,
      name: "Grocery",
      archivedAt: null,
    });
    const seeded = await seedCard(handles);
    return { handles, ...seeded };
  }

  it("rejects a concurrent second base opening", async () => {
    const ctx = await setupPg();
    await assertDoubleOpeningRace(ctx.handles, ctx.handles, ctx.workspaceId, ctx.cardId);
  });

  it("serializes opening vs real card spend", async () => {
    const ctx = await setupPg();
    await assertOpeningVsSpendRace(ctx.handles, ctx.handles, ctx.workspaceId, ctx.cardId, ctx.groceryId);
  });
});
