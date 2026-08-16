import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { comingUpItems, filterComingUp } from "../../src/domain/engine/comingUp.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { comingUp, comingUpPreview, currentMonthSpend, home } from "../../src/db/reads.js";
import { configVersions, financialEvents, fundingCycles, incomePolicies, obligationInstances, postings } from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import {
  archiveObligationTemplate,
  changeObligationFrom,
  createObligationTemplate,
  createOneOffObligation,
} from "../../src/app/obligations.js";
import { ensureObligationInstances } from "../../src/app/ensureObligationInstances.js";
import { recordObligationPayment } from "../../src/app/recordObligationPayment.js";
import { skipObligation } from "../../src/app/skipObligation.js";
import { createCard } from "../../src/app/cards.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { simulateAffordability } from "../../src/app/simulateAffordability.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  if (!hdfc || !grocery) throw new Error("Expected seed");
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 5_000_000,
    commit: true,
  });
  return { handles, workspaceId, hdfcId: hdfc.id, groceryId: grocery.id };
}

describe("stage 13 obligations and coming up", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("G — one-off appears in Coming Up and STS", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Car repair",
      dueOn: "2026-08-18",
      amountPaise: 850_000,
      priority: "must_pay",
    });
    const asOf = isoDate("2026-08-20");
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const sts = evaluateSafeToSpend(snapshot, asOf);
    const items = comingUpItems(snapshot, asOf);
    expect(items.some((item) => item.name === "Car repair")).toBe(true);
    expect(sts.includedObligations.some((item) => item.name.includes("Car repair"))).toBe(true);
    expect(sts.currentCycleSafeToSpend).toBe(4_150_000);
  });

  it("H / I — must-pay and committed follow Stage 12 inclusion", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createObligationTemplate(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Insurance",
      priority: "committed",
      dayOfMonth: 18,
      amountPaise: 200_000,
      effectiveFrom: "2026-01-01",
    });
    const asOf = isoDate("2026-08-20");
    await ensureObligationInstances(ctx.handles, ctx.workspaceId, asOf);
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const sts = evaluateSafeToSpend(snapshot, asOf);
    expect(sts.includedObligations.some((item) => item.priority === "committed")).toBe(true);
  });

  it("J — planned is visible in Coming Up and does not reduce STS", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "SIP",
      dueOn: "2026-08-18",
      amountPaise: 500_000,
      priority: "planned",
    });
    const asOf = isoDate("2026-08-20");
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const before = 5_000_000;
    const sts = evaluateSafeToSpend(snapshot, asOf);
    expect(sts.currentCycleSafeToSpend).toBe(before);
    expect(comingUpItems(snapshot, asOf).some((item) => item.name === "SIP")).toBe(true);
  });

  it("K — delayed salary includes a real overdue-window instance", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    ctx.handles.db
      .insert(incomePolicies)
      .values({
        id: "policy",
        workspaceId: ctx.workspaceId,
        expectedAmountPaise: 7_920_000,
        windowStartDay: 4,
        windowEndDay: 8,
        typicalDay: 5,
        effectiveFrom: "2020-01-01",
        effectiveTo: null,
      })
      .run();
    ctx.handles.db
      .insert(fundingCycles)
      .values({
        id: "aug",
        workspaceId: ctx.workspaceId,
        year: 2026,
        month: 8,
        expectedWindowStart: "2026-08-04",
        expectedWindowEnd: "2026-08-08",
        expectedAmountSnapshot: 7_920_000,
        actualArrivalOn: "2026-08-05",
        actualAmountPaise: 7_920_000,
        salaryEventId: null,
      })
      .run();
    await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Family",
      dueOn: "2026-09-24",
      amountPaise: 800_000,
      priority: "must_pay",
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-09-10"));
    const third = evaluateSafeToSpend(snapshot, isoDate("2026-09-03"));
    const sixth = evaluateSafeToSpend(snapshot, isoDate("2026-09-06"));
    const tenth = evaluateSafeToSpend(snapshot, isoDate("2026-09-10"));
    expect(third.includedObligations.some((item) => item.name.includes("Family"))).toBe(false);
    expect(sixth.includedObligations.some((item) => item.name.includes("Family"))).toBe(false);
    expect(tenth.includedObligations.some((item) => item.name.includes("Family"))).toBe(true);
    expect(tenth.riskFlags).toContain("expected_income_delayed");
  });

  it("L — no salary policy keeps the obligation and invents no window", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Rent",
      dueOn: "2026-09-24",
      amountPaise: 1_200_000,
      priority: "must_pay",
    });
    const asOf = isoDate("2026-09-10");
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const sts = evaluateSafeToSpend(snapshot, asOf);
    const filtered = filterComingUp(comingUpItems(snapshot, asOf), snapshot, asOf, "until_next_salary");
    expect(snapshot.obligationInstances).toHaveLength(1);
    expect(sts.incomePolicyConfigured).toBe(false);
    expect(sts.nextExpectedIncomeWindow.start).toBeNull();
    expect(filtered.filterAvailable).toBe(false);
  });

  it("M / N — full payment decreases the account, marks paid, and is not Month Review spend", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const created = await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Rent",
      dueOn: "2026-08-18",
      amountPaise: 1_200_000,
      priority: "must_pay",
    });
    const beforeSpend = (await currentMonthSpend(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"))).spentPaise;
    await recordObligationPayment(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-18",
      capturedAt,
      instanceId: created.id,
      accountId: ctx.hdfcId,
      amountPaise: 1_200_000,
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"));
    const hdfc = snapshot.accounts.find((account) => account.id === ctx.hdfcId);
    const instance = snapshot.obligationInstances.find((item) => item.id === created.id);
    expect(hdfc?.balancePaise).toBe(3_800_000);
    expect(instance?.status).toBe("paid");
    expect(evaluateSafeToSpend(snapshot, isoDate("2026-08-20")).includedObligations).toHaveLength(0);
    expect(comingUpItems(snapshot, isoDate("2026-08-20")).some((item) => item.id === created.id)).toBe(false);
    expect((await currentMonthSpend(ctx.handles, ctx.workspaceId, isoDate("2026-08-20"))).spentPaise).toBe(beforeSpend);
  });

  it("O — skip leaves the instance historical and not open", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const created = await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Skip me",
      dueOn: "2026-08-18",
      amountPaise: 100_000,
      priority: "must_pay",
    });
    await skipObligation(ctx.handles, { workspaceId: ctx.workspaceId }, { instanceId: created.id });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const instance = snapshot.obligationInstances.find((item) => item.id === created.id);
    expect(instance?.status).toBe("skipped");
    expect(comingUpItems(snapshot, isoDate("2026-08-20")).some((item) => item.id === created.id)).toBe(false);
  });

  it("P / Q — Coming Up unions cards and obligations with overdue first", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const card = await createCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      displayName: "ICICI",
      issuer: "ICICI",
      mask: "8001",
      statementDay: 12,
      dueDaysAfterStatement: 18,
      commit: true,
    });
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-20",
      capturedAt,
      creditCardId: card.id,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 400_000 }],
      commit: true,
    });
    await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Overdue rent",
      dueOn: "2026-08-10",
      amountPaise: 100_000,
      priority: "must_pay",
    });
    await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Later bill",
      dueOn: "2026-09-30",
      amountPaise: 100_000,
      priority: "must_pay",
    });
    const items = (await comingUp(ctx.handles, ctx.workspaceId, isoDate("2026-08-25"), "all_open")).items;
    expect(items[0]?.name).toBe("Overdue rent");
    expect(items.some((item) => item.type === "card")).toBe(true);
    expect(items.some((item) => item.type === "obligation")).toBe(true);
  });

  it("R — historical template edit does not rewrite past instances", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const template = await createObligationTemplate(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Rent",
      priority: "must_pay",
      dayOfMonth: 5,
      amountPaise: 1_200_000,
      effectiveFrom: "2026-01-01",
    });
    await ensureObligationInstances(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    const before = (await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-16")))
      .obligationInstances.find((item) => item.dueOn === "2026-08-05");
    await changeObligationFrom(ctx.handles, { workspaceId: ctx.workspaceId }, {
      templateId: template.id,
      effectiveFrom: "2026-09-01",
      amountPaise: 1_300_000,
      name: "House rent",
    });
    const after = (await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-16")))
      .obligationInstances.find((item) => item.id === before?.id);
    expect(after?.amountPaise).toBe(1_200_000);
    expect(after?.nameSnapshot).toBe("Rent");
    await archiveObligationTemplate(ctx.handles, { workspaceId: ctx.workspaceId }, {
      templateId: template.id,
      effectiveTo: "2026-12-01",
    });
    expect(
      (await loadSnapshot(ctx.handles, ctx.workspaceId)).obligationInstances.find((item) => item.id === before?.id),
    ).toBeTruthy();
  });

  it("S — failed payment commits nothing", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const created = await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Rent",
      dueOn: "2026-08-18",
      amountPaise: 1_200_000,
      priority: "must_pay",
    });
    const eventsBefore =
      ctx.handles.db.select({ value: count() }).from(financialEvents).where(eq(financialEvents.workspaceId, ctx.workspaceId)).get()?.value ?? 0;
    await expect(
      recordObligationPayment(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-18",
        capturedAt,
        instanceId: created.id,
        accountId: ctx.hdfcId,
        amountPaise: 100_000,
        commit: true,
      }),
    ).rejects.toThrow(/full remaining amount/);
    const eventsAfter =
      ctx.handles.db.select({ value: count() }).from(financialEvents).where(eq(financialEvents.workspaceId, ctx.workspaceId)).get()?.value ?? 0;
    const instance = ctx.handles.db.select().from(obligationInstances).where(eq(obligationInstances.id, created.id)).get();
    expect(eventsAfter).toBe(eventsBefore);
    expect(instance?.status).toBe("open");
    expect(
      ctx.handles.db.select({ value: count() }).from(postings).where(eq(postings.workspaceId, ctx.workspaceId)).get()?.value,
    ).toBeDefined();
  });

  it("T — Home preview is the same source as full Coming Up", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createOneOffObligation(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Rent",
      dueOn: "2026-08-18",
      amountPaise: 100_000,
      priority: "must_pay",
    });
    const asOf = isoDate("2026-08-20");
    const full = (await comingUp(ctx.handles, ctx.workspaceId, asOf, "all_open")).items.slice(0, 5);
    const preview = await comingUpPreview(ctx.handles, ctx.workspaceId, asOf);
    const view = await home(ctx.handles, ctx.workspaceId, asOf);
    expect(preview).toEqual(full);
    expect(view.coming.map((item) => item.id)).toEqual(preview.map((item) => item.id));
  });

  it("read paths do not materialize instances after explicit preparation", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createObligationTemplate(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Rent",
      priority: "must_pay",
      dayOfMonth: 5,
      amountPaise: 1_200_000,
      effectiveFrom: "2026-01-01",
    });
    const asOf = isoDate("2026-08-16");
    await ensureObligationInstances(ctx.handles, ctx.workspaceId, asOf);
    const firstEnsureAgain = await ensureObligationInstances(ctx.handles, ctx.workspaceId, asOf);
    expect(firstEnsureAgain).toBe(0);

    const captured = captureDb(ctx.handles, ctx.workspaceId);
    for (let round = 0; round < 2; round += 1) {
      const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
      evaluateSafeToSpend(snapshot, asOf);
      await comingUp(ctx.handles, ctx.workspaceId, asOf, "all_open");
      await home(ctx.handles, ctx.workspaceId, asOf);
      await simulateAffordability(ctx.handles, { workspaceId: ctx.workspaceId }, {
        amountPaise: 50_000,
        occurredOn: "2026-08-16",
        funding: { accountId: ctx.hdfcId },
      });
    }
    expect(captureDb(ctx.handles, ctx.workspaceId)).toEqual(captured);

    const later = isoDate("2026-09-16");
    const created = await ensureObligationInstances(ctx.handles, ctx.workspaceId, later);
    expect(created).toBeGreaterThan(0);
    const afterAdvance = captureDb(ctx.handles, ctx.workspaceId);
    expect(afterAdvance.instances).toBe(captured.instances + created);
    expect(afterAdvance.events).toBe(captured.events);
    expect(afterAdvance.postings).toBe(captured.postings);
    expect(afterAdvance.configs).toBe(captured.configs);
    expect(
      ctx.handles.db
        .select()
        .from(obligationInstances)
        .where(eq(obligationInstances.workspaceId, ctx.workspaceId))
        .all()
        .some((row) => row.dueOn === "2027-01-05"),
    ).toBe(true);

    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, later);
    evaluateSafeToSpend(snapshot, later);
    await comingUp(ctx.handles, ctx.workspaceId, later, "all_open");
    await home(ctx.handles, ctx.workspaceId, later);
    await simulateAffordability(ctx.handles, { workspaceId: ctx.workspaceId }, {
      amountPaise: 50_000,
      occurredOn: "2026-09-16",
      funding: { accountId: ctx.hdfcId },
    });
    expect(captureDb(ctx.handles, ctx.workspaceId)).toEqual(afterAdvance);
  });
});

function captureDb(handles: SqliteHandles, workspaceId: string) {
  return {
    instances:
      handles.db.select({ value: count() }).from(obligationInstances).where(eq(obligationInstances.workspaceId, workspaceId)).get()?.value ?? 0,
    events:
      handles.db.select({ value: count() }).from(financialEvents).where(eq(financialEvents.workspaceId, workspaceId)).get()?.value ?? 0,
    postings:
      handles.db.select({ value: count() }).from(postings).where(eq(postings.workspaceId, workspaceId)).get()?.value ?? 0,
    configs:
      handles.db.select({ value: count() }).from(configVersions).where(eq(configVersions.workspaceId, workspaceId)).get()?.value ?? 0,
  };
}
