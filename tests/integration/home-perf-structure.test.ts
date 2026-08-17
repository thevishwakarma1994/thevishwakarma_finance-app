import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { evaluateSafeToSpend } from "../../src/domain/engine/evaluateSafeToSpend.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadCardRule } from "../../src/db/config.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import {
  comingUpFromSnapshot,
  comingUpPreviewFromSnapshot,
  home,
  listPeopleFromSnapshot,
  peoplePreviewFromSnapshot,
} from "../../src/db/reads.js";
import { createCard } from "../../src/app/cards.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { createOneOffObligation } from "../../src/app/obligations.js";
import { createPerson } from "../../src/app/people.js";
import { lendMoney } from "../../src/app/lendMoney.js";
import { ensureObligationInstances } from "../../src/app/ensureObligationInstances.js";
import { simulateAffordability } from "../../src/app/simulateAffordability.js";
import { createPerfMarks, runWithPerf } from "../../src/perf/timing.js";
import { financialEvents, obligationInstances, postings } from "../../src/db/schema.js";
import { count, eq } from "drizzle-orm";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  if (!hdfc) throw new Error("Expected seeded HDFC");
  await applyOpening(
    handles,
    { workspaceId },
    {
      accountId: hdfc.id,
      effectiveOn: "2026-08-01",
      balancePaise: 2_000_000,
      commit: true,
    },
  );
  return { handles, workspaceId, hdfcId: hdfc.id };
}

describe("home performance structure", () => {
  const contexts: SqliteHandles[] = [];

  afterEach(() => {
    for (const handles of contexts) {
      handles.sqlite.close();
    }
    contexts.length = 0;
  });

  it("A — Home calls loadSnapshot exactly once", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const marks = createPerfMarks("/api/home");
    await runWithPerf(marks, async () => {
      await home(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    });
    expect(marks.snapshotCalls).toBe(1);
  });

  it("B/C — Coming Up and People previews use the Home snapshot (no extra loadSnapshot)", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createOneOffObligation(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      {
        name: "Rent",
        dueOn: "2026-08-18",
        amountPaise: 100_000,
        priority: "must_pay",
      },
    );
    const person = await createPerson(ctx.handles, { workspaceId: ctx.workspaceId }, {
      name: "Asha",
    });
    await lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      personId: person.id,
      accountId: ctx.hdfcId,
      amountPaise: 50_000,
      occurredOn: "2026-08-10",
      capturedAt: "2026-08-10T10:00:00.000Z",
      commit: true,
    });

    const marks = createPerfMarks("/api/home");
    let view: Awaited<ReturnType<typeof home>>;
    await runWithPerf(marks, async () => {
      view = await home(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    });
    expect(marks.snapshotCalls).toBe(1);

    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    expect(view!.coming).toEqual(comingUpPreviewFromSnapshot(snapshot, isoDate("2026-08-16")));
    expect(view!.people).toEqual(peoplePreviewFromSnapshot(snapshot));
    expect(comingUpFromSnapshot(snapshot, isoDate("2026-08-16")).items.slice(0, 5)).toEqual(
      view!.coming,
    );
    expect(listPeopleFromSnapshot(snapshot).some((p) => p.id === person.id)).toBe(true);
  });

  it("D — loadSnapshot is deterministic across repeated loads", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await createCard(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      {
        displayName: "ICICI",
        issuer: "ICICI",
        mask: "8001",
        statementDay: 12,
        dueDaysAfterStatement: 20,
        defaultPaymentAccountId: ctx.hdfcId,
      },
    );
    const asOf = isoDate("2026-08-16");
    const first = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const second = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    expect(second).toEqual(first);
  });

  it("E — batched card rules match per-card loadCardRule effective dating", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const card = await createCard(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      {
        displayName: "HDFC Regalia",
        issuer: "HDFC",
        mask: "1234",
        statementDay: 5,
        dueDaysAfterStatement: 15,
        defaultPaymentAccountId: ctx.hdfcId,
      },
    );
    const asOf = isoDate("2026-08-16");
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const batched = snapshot.cardRules.find((item) => item.creditCardId === card.id)?.rule;
    const direct = await loadCardRule(ctx.handles, ctx.workspaceId, card.id, asOf);
    expect(batched).toEqual(direct);
  });

  it("F/G — STS and affordability results stay consistent with snapshot evaluation", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const asOf = isoDate("2026-08-16");
    await ensureObligationInstances(ctx.handles, ctx.workspaceId, asOf);
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId, asOf);
    const sts = evaluateSafeToSpend(snapshot, asOf);
    const view = await home(ctx.handles, ctx.workspaceId, asOf);
    expect(view.currentCycleSafeToSpend).toBe(sts.currentCycleSafeToSpend);
    expect(view.liquidTotal).toBe(sts.liquidTotal);
    expect(view.explanationItems).toEqual(sts.explanationItems);

    const eventsBefore =
      ctx.handles.db
        .select({ value: count() })
        .from(financialEvents)
        .where(eq(financialEvents.workspaceId, ctx.workspaceId))
        .get()?.value ?? 0;
    const afford = await simulateAffordability(
      ctx.handles,
      { workspaceId: ctx.workspaceId },
      {
        amountPaise: 50_000,
        occurredOn: "2026-08-16",
        funding: { accountId: ctx.hdfcId },
      },
    );
    const eventsAfter =
      ctx.handles.db
        .select({ value: count() })
        .from(financialEvents)
        .where(eq(financialEvents.workspaceId, ctx.workspaceId))
        .get()?.value ?? 0;
    expect(eventsAfter).toBe(eventsBefore);
    expect(afford.baseline.currentCycleSafeToSpend).toBe(sts.currentCycleSafeToSpend);
  });

  it("I — Home read path remains write-free after obligation preparation", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const asOf = isoDate("2026-08-16");
    await ensureObligationInstances(ctx.handles, ctx.workspaceId, asOf);
    const before = {
      instances:
        ctx.handles.db
          .select({ value: count() })
          .from(obligationInstances)
          .where(eq(obligationInstances.workspaceId, ctx.workspaceId))
          .get()?.value ?? 0,
      events:
        ctx.handles.db
          .select({ value: count() })
          .from(financialEvents)
          .where(eq(financialEvents.workspaceId, ctx.workspaceId))
          .get()?.value ?? 0,
      postings:
        ctx.handles.db
          .select({ value: count() })
          .from(postings)
          .where(eq(postings.workspaceId, ctx.workspaceId))
          .get()?.value ?? 0,
    };
    await home(ctx.handles, ctx.workspaceId, asOf);
    const after = {
      instances:
        ctx.handles.db
          .select({ value: count() })
          .from(obligationInstances)
          .where(eq(obligationInstances.workspaceId, ctx.workspaceId))
          .get()?.value ?? 0,
      events:
        ctx.handles.db
          .select({ value: count() })
          .from(financialEvents)
          .where(eq(financialEvents.workspaceId, ctx.workspaceId))
          .get()?.value ?? 0,
      postings:
        ctx.handles.db
          .select({ value: count() })
          .from(postings)
          .where(eq(postings.workspaceId, ctx.workspaceId))
          .get()?.value ?? 0,
    };
    expect(after).toEqual(before);
  });
});
