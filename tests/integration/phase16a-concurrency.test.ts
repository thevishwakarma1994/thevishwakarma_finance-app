import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type DbHandles, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId, LEGACY_WORKSPACE_NAME } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { applyOpeningCard, correctOpeningCard } from "../../src/app/openingCard.js";
import { applyOpeningReservation, correctOpeningReservation } from "../../src/app/openingReservation.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { confirmStatement } from "../../src/app/confirmStatement.js";
import { payCard } from "../../src/app/payCard.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { createCard } from "../../src/app/cards.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { deriveOpeningCardPosition } from "../../src/domain/commands/openingCard.js";
import { DomainError, type LedgerSnapshot } from "../../src/domain/ledger/types.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";
import type { IsoDate } from "../../src/domain/calendar/isoDate.js";
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

async function seedEligibleCardOpening(handles: DbHandles, workspaceId: string, cardId: string) {
  await applyOpeningCard(handles, { workspaceId }, openingPayload("cmd-open-eligible", cardId));
  const snapshot = await loadSnapshot(handles, workspaceId);
  const cycle = snapshot.billingCycles.find((row) => row.creditCardId === cardId);
  if (!cycle) throw new Error("Expected opening to materialize a billing cycle");
  return cycle.id;
}

async function assertCorrectionVsSpendRace(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  cardId: string,
  groceryId: string,
  billingCycleId: string,
) {
  const results = await Promise.allSettled([
    correctOpeningCard(left, { workspaceId }, {
      commandId: "cmd-cor-card-race",
      occurredOn: "2026-08-06",
      capturedAt,
      creditCardId: cardId,
      billingCycleId,
      targetAmountPaise: 18_000_00,
    }),
    recordCardSpend(right, { workspaceId }, {
      occurredOn: "2026-08-05",
      capturedAt,
      creditCardId: cardId,
      allocations: [{ categoryId: groceryId, amountPaise: 1_000_00 }],
      commit: true,
    }),
  ]);
  const correction = results[0]!;
  const spend = results[1]!;
  expect(spend.status).toBe("fulfilled");

  const snapshot = await loadSnapshot(left, workspaceId);
  const correctionEvents = snapshot.events.filter(
    (event) => event.meaning === "correct_opening_card_position" && event.creditCardId === cardId,
  );
  const spendEvents = snapshot.events.filter(
    (event) => event.meaning === "spend_card" && event.creditCardId === cardId,
  );
  expect(spendEvents).toHaveLength(1);

  const position = deriveOpeningCardPosition(snapshot, billingCycleId);
  expect(position.hasLifecycleActivity).toBe(true);
  expect(position.baseEventId).toBe("cmd-open-eligible");

  if (correction.status === "fulfilled") {
    expect(correctionEvents).toHaveLength(1);
    expect(position.currentEffectiveAmountPaise).toBe(18_000_00);
  } else {
    expect(isDomain(correction.reason, "invalid_opening")).toBe(true);
    expect(correctionEvents).toHaveLength(0);
    expect(position.currentEffectiveAmountPaise).toBe(20_000_00);
  }
}

function openingReservationsForCycle(snapshot: LedgerSnapshot, cycleId: string) {
  return snapshot.reservations.filter((reservation) => {
    if (reservation.obligationRef.type !== "billing_cycle" || reservation.obligationRef.id !== cycleId) {
      return false;
    }
    const origin = snapshot.events.find((event) => event.id === reservation.originatingEventId);
    return origin?.meaning === "apply_opening_reservation" || origin?.meaning === "correct_opening_reservation";
  });
}

async function seedReservationPayRace(
  handles: DbHandles,
  workspaceId: string,
  cardId: string,
  hdfcId: string,
) {
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfcId,
    effectiveOn: "2026-08-01",
    balancePaise: 50_000_00,
    commit: true,
  });
  await applyOpeningCard(handles, { workspaceId }, openingPayload("cmd-open-card-res", cardId));
  const snapshot = await loadSnapshot(handles, workspaceId);
  const cycle = snapshot.billingCycles.find((row) => row.creditCardId === cardId);
  if (!cycle) throw new Error("Expected opening to materialize a billing cycle");
  await confirmStatement(handles, { workspaceId }, {
    cycleId: cycle.id,
    actualStatementAmountPaise: 20_000_00,
    actualStatementOn: "2026-08-10",
    actualDueOn: "2026-08-30",
  });
  await applyOpeningReservation(handles, { workspaceId }, {
    commandId: "cmd-open-res",
    occurredOn: "2026-08-05",
    capturedAt,
    sourceAccountId: hdfcId,
    cardId,
    billingCycleId: cycle.id,
    amountPaise: 5_000_00,
  });
  return { cycleId: cycle.id, reservationId: "cmd-open-res_res" };
}

async function assertReservationVsPayCardRace(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  cardId: string,
  hdfcId: string,
  cycleId: string,
  reservationId: string,
) {
  const results = await Promise.allSettled([
    correctOpeningReservation(left, { workspaceId }, {
      commandId: "cmd-cor-res-race",
      occurredOn: "2026-08-06",
      capturedAt,
      reservationId,
      targetAmountPaise: 3_000_00,
    }),
    payCard(right, { workspaceId }, {
      occurredOn: "2026-08-22",
      capturedAt,
      creditCardId: cardId,
      billingCycleId: cycleId,
      accountId: hdfcId,
      amountPaise: 20_000_00,
      commit: true,
    }),
  ]);
  const correction = results[0]!;
  const payment = results[1]!;
  expect(payment.status).toBe("fulfilled");

  const snapshot = await loadSnapshot(left, workspaceId);
  const original = snapshot.reservations.find((row) => row.id === reservationId);
  const replacement = snapshot.reservations.find((row) => row.id === "cmd-cor-res-race_res");
  const correctionEvents = snapshot.events.filter((event) => event.meaning === "correct_opening_reservation");
  const payEvents = snapshot.events.filter(
    (event) => event.meaning === "pay_obligation" && event.creditCardId === cardId,
  );
  expect(payEvents).toHaveLength(1);
  expect(original).toBeTruthy();

  const openings = openingReservationsForCycle(snapshot, cycleId);
  expect(openings.filter((row) => row.status === "active")).toHaveLength(0);

  const bank = snapshot.accounts.find((account) => account.id === hdfcId)!;
  expect(bank.balancePaise).toBe(30_000_00);
  const sts = evaluateSafeToSpend(snapshot, "2026-08-23" as IsoDate);
  expect(sts.reservedTotal).toBe(0);

  const cycle = snapshot.billingCycles.find((row) => row.id === cycleId)!;
  expect(cycle.remainingPaise).toBe(0);

  if (correction.status === "fulfilled") {
    expect(correctionEvents).toHaveLength(1);
    expect(replacement).toBeTruthy();
    expect(original!.amountReleasedPaise).toBe(5_000_00);
    expect(original!.amountConsumedPaise).toBe(0);
    expect(replacement!.amountConsumedPaise).toBe(3_000_00);
    expect(replacement!.status).not.toBe("active");
  } else {
    expect(isDomain(correction.reason, "invalid_opening")).toBe(true);
    expect(correctionEvents).toHaveLength(0);
    expect(replacement).toBeUndefined();
    expect(original!.amountConsumedPaise).toBe(5_000_00);
    expect(original!.amountReleasedPaise).toBe(0);
  }
}

async function seedOutstandingCycle(
  handles: DbHandles,
  workspaceId: string,
  cardId: string,
  hdfcId: string,
  openingCommandId: string,
) {
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfcId,
    effectiveOn: "2026-08-01",
    balancePaise: 50_000_00,
    commit: true,
  });
  await applyOpeningCard(handles, { workspaceId }, openingPayload(openingCommandId, cardId));
  const snapshot = await loadSnapshot(handles, workspaceId);
  const cycle = snapshot.billingCycles.find((row) => row.creditCardId === cardId);
  if (!cycle) throw new Error("Expected opening to materialize a billing cycle");
  await confirmStatement(handles, { workspaceId }, {
    cycleId: cycle.id,
    actualStatementAmountPaise: 20_000_00,
    actualStatementOn: "2026-08-10",
    actualDueOn: "2026-08-30",
  });
  return { cycleId: cycle.id };
}

async function assertApplyReservationVsPayCardRace(
  left: DbHandles,
  right: DbHandles,
  workspaceId: string,
  cardId: string,
  hdfcId: string,
  cycleId: string,
) {
  const results = await Promise.allSettled([
    applyOpeningReservation(left, { workspaceId }, {
      commandId: "cmd-apply-res-race",
      occurredOn: "2026-08-05",
      capturedAt,
      sourceAccountId: hdfcId,
      cardId,
      billingCycleId: cycleId,
      amountPaise: 5_000_00,
    }),
    payCard(right, { workspaceId }, {
      occurredOn: "2026-08-22",
      capturedAt,
      creditCardId: cardId,
      billingCycleId: cycleId,
      accountId: hdfcId,
      amountPaise: 20_000_00,
      commit: true,
    }),
  ]);
  const apply = results[0]!;
  const payment = results[1]!;
  expect(payment.status).toBe("fulfilled");

  const snapshot = await loadSnapshot(left, workspaceId);
  const applyEvents = snapshot.events.filter((event) => event.id === "cmd-apply-res-race");
  const payEvents = snapshot.events.filter(
    (event) => event.meaning === "pay_obligation" && event.creditCardId === cardId,
  );
  expect(payEvents).toHaveLength(1);

  const openings = openingReservationsForCycle(snapshot, cycleId);
  expect(openings.filter((row) => row.status === "active")).toHaveLength(0);

  const bank = snapshot.accounts.find((account) => account.id === hdfcId)!;
  expect(bank.balancePaise).toBe(30_000_00);
  const sts = evaluateSafeToSpend(snapshot, "2026-08-23" as IsoDate);
  expect(sts.reservedTotal).toBe(0);

  const cycle = snapshot.billingCycles.find((row) => row.id === cycleId)!;
  expect(cycle.remainingPaise).toBe(0);
  expect(cycle.status).toBe("paid");
  expect(cycle.lifecycle).toBe("paid");

  if (apply.status === "fulfilled") {
    expect(applyEvents).toHaveLength(1);
    const created = snapshot.reservations.find((row) => row.id === "cmd-apply-res-race_res");
    expect(created).toBeTruthy();
    expect(created!.status).not.toBe("active");
    expect(created!.amountConsumedPaise).toBe(5_000_00);
  } else {
    expect(isDomain(apply.reason, "invalid_opening")).toBe(true);
    expect(applyEvents).toHaveLength(0);
    expect(snapshot.reservations.find((row) => row.id === "cmd-apply-res-race_res")).toBeUndefined();
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

  it("serializes opening-card correction vs real card spend", async () => {
    const ctx = await dualSqlite();
    const billingCycleId = await seedEligibleCardOpening(ctx.a, ctx.workspaceId, ctx.cardId);
    await assertCorrectionVsSpendRace(
      ctx.a,
      ctx.b,
      ctx.workspaceId,
      ctx.cardId,
      ctx.groceryId,
      billingCycleId,
    );
  });

  it("serializes opening-reservation correction vs real payCard", async () => {
    const ctx = await dualSqlite();
    const seeded = await seedReservationPayRace(ctx.a, ctx.workspaceId, ctx.cardId, ctx.hdfcId);
    await assertReservationVsPayCardRace(
      ctx.a,
      ctx.b,
      ctx.workspaceId,
      ctx.cardId,
      ctx.hdfcId,
      seeded.cycleId,
      seeded.reservationId,
    );
  });

  it("serializes opening-reservation apply vs real payCard", async () => {
    const ctx = await dualSqlite();
    const seeded = await seedOutstandingCycle(
      ctx.a,
      ctx.workspaceId,
      ctx.cardId,
      ctx.hdfcId,
      "cmd-open-card-apply-res",
    );
    await assertApplyReservationVsPayCardRace(
      ctx.a,
      ctx.b,
      ctx.workspaceId,
      ctx.cardId,
      ctx.hdfcId,
      seeded.cycleId,
    );
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

  it("serializes opening-card correction vs real card spend", async () => {
    const ctx = await setupPg();
    const billingCycleId = await seedEligibleCardOpening(ctx.handles, ctx.workspaceId, ctx.cardId);
    await assertCorrectionVsSpendRace(
      ctx.handles,
      ctx.handles,
      ctx.workspaceId,
      ctx.cardId,
      ctx.groceryId,
      billingCycleId,
    );
  });

  it("serializes opening-reservation correction vs real payCard", async () => {
    const ctx = await setupPg();
    const seeded = await seedReservationPayRace(ctx.handles, ctx.workspaceId, ctx.cardId, ctx.hdfcId);
    await assertReservationVsPayCardRace(
      ctx.handles,
      ctx.handles,
      ctx.workspaceId,
      ctx.cardId,
      ctx.hdfcId,
      seeded.cycleId,
      seeded.reservationId,
    );
  });

  it("serializes opening-reservation apply vs real payCard", async () => {
    const ctx = await setupPg();
    const seeded = await seedOutstandingCycle(
      ctx.handles,
      ctx.workspaceId,
      ctx.cardId,
      ctx.hdfcId,
      "cmd-open-card-apply-res",
    );
    await assertApplyReservationVsPayCardRace(
      ctx.handles,
      ctx.handles,
      ctx.workspaceId,
      ctx.cardId,
      ctx.hdfcId,
      seeded.cycleId,
    );
  });
});
