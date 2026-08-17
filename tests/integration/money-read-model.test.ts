import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import {
  comingCardPayments,
  currentMonthSpend,
  listAccounts,
  listCards,
  listCategories,
  listPeople,
  listPendingSurplus,
  money,
} from "../../src/db/reads.js";
import { listObligationTemplates } from "../../src/app/obligations.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { createCard } from "../../src/app/cards.js";
import { createPerson } from "../../src/app/people.js";
import { lendMoney } from "../../src/app/lendMoney.js";
import { ensureObligationInstances } from "../../src/app/ensureObligationInstances.js";
import { createPerfMarks, runWithPerf } from "../../src/perf/timing.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import type { VerifyIdToken } from "../../src/api/auth/guard.js";

const verifyIdToken: VerifyIdToken = async (token) => {
  if (token === "invalid") throw new Error("rejected");
  return { uid: token, email: `${token}@example.test`, displayName: token };
};

async function setupDb() {
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

async function api(
  app: ReturnType<typeof createApp>,
  token: string,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.method && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("origin", "http://localhost:5173");
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return app.request(path, { ...init, headers });
}

describe("money read model", () => {
  const contexts: SqliteHandles[] = [];

  afterEach(() => {
    for (const handles of contexts) handles.sqlite.close();
    contexts.length = 0;
  });

  it("A — Money mount path is a single /api/money HTTP request", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);
    const app = createApp(handles, { verifyIdToken });
    await api(app, "money-user", "/api/me");
    const response = await api(app, "money-user", "/api/money");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      accounts: unknown[];
      cards: unknown[];
      month: { spentPaise: number };
    };
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(Array.isArray(body.cards)).toBe(true);
    expect(typeof body.month.spentPaise).toBe("number");
    // Structural: one endpoint returns the full Money DTO (client replaces 8 calls with this one).
    expect(Object.keys(body).sort()).toEqual(
      [
        "accounts",
        "asOf",
        "cards",
        "categories",
        "comingCardPayments",
        "month",
        "people",
        "surplus",
        "templates",
      ].sort(),
    );
  });

  it("B — money() calls loadSnapshot exactly once", async () => {
    const ctx = await setupDb();
    contexts.push(ctx.handles);
    await ensureObligationInstances(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    const marks = createPerfMarks("/api/money");
    await runWithPerf(marks, async () => {
      await money(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    });
    expect(marks.snapshotCalls).toBe(1);
  });

  it("C/F/G/H/I/J — Money DTO matches individual read models", async () => {
    const ctx = await setupDb();
    contexts.push(ctx.handles);
    const asOf = isoDate("2026-08-16");
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
    const person = await createPerson(ctx.handles, { workspaceId: ctx.workspaceId }, { name: "Asha" });
    await lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      personId: person.id,
      accountId: ctx.hdfcId,
      amountPaise: 25_000,
      occurredOn: "2026-08-10",
      capturedAt: "2026-08-10T10:00:00.000Z",
      commit: true,
    });
    await ensureObligationInstances(ctx.handles, ctx.workspaceId, asOf);

    const view = await money(ctx.handles, ctx.workspaceId, asOf);
    expect(view.accounts).toEqual(await listAccounts(ctx.handles, ctx.workspaceId));
    expect(view.categories).toEqual(await listCategories(ctx.handles, ctx.workspaceId));
    expect(view.cards).toEqual(await listCards(ctx.handles, ctx.workspaceId, asOf));
    expect(view.comingCardPayments).toEqual(await comingCardPayments(ctx.handles, ctx.workspaceId, asOf));
    expect(view.people).toEqual(await listPeople(ctx.handles, ctx.workspaceId));
    expect(view.surplus).toEqual(await listPendingSurplus(ctx.handles, ctx.workspaceId));
    expect(view.templates).toEqual(await listObligationTemplates(ctx.handles, ctx.workspaceId));
    expect(view.month).toEqual(await currentMonthSpend(ctx.handles, ctx.workspaceId, asOf));
    expect(view.accounts.some((account) => account.id === ctx.hdfcId)).toBe(true);
    const hdfc = view.accounts.find((account) => account.id === ctx.hdfcId);
    expect(hdfc?.reservedPaise).toBeTypeOf("number");
    expect(hdfc?.availablePaise).toBeTypeOf("number");
    expect(view.cards[0]?.outstandingPaise).toBeTypeOf("number");
    expect(view.people.find((p) => p.id === person.id)?.netPaise).toBe(25_000);
  });

  it("D/E — workspace isolation on /api/money", async () => {
    const handles = openMemoryDatabase();
    contexts.push(handles);
    await applyMigrations(handles);
    const app = createApp(handles, { verifyIdToken });

    const meA = (await api(app, "user-a", "/api/me").then((r) => r.json())) as {
      workspaceId: string;
    };
    const meB = (await api(app, "user-b", "/api/me").then((r) => r.json())) as {
      workspaceId: string;
    };
    expect(meA.workspaceId).not.toBe(meB.workspaceId);

    await api(app, "user-a", "/api/accounts", {
      method: "POST",
      body: JSON.stringify({ displayName: "A-Only Bank", kind: "bank" }),
    });
    await api(app, "user-b", "/api/accounts", {
      method: "POST",
      body: JSON.stringify({ displayName: "B-Only Bank", kind: "bank" }),
    });

    const moneyA = (await api(app, "user-a", "/api/money").then((r) => r.json())) as {
      accounts: { displayName: string }[];
    };
    const moneyB = (await api(app, "user-b", "/api/money").then((r) => r.json())) as {
      accounts: { displayName: string }[];
    };
    expect(moneyA.accounts.some((a) => a.displayName === "A-Only Bank")).toBe(true);
    expect(moneyA.accounts.some((a) => a.displayName === "B-Only Bank")).toBe(false);
    expect(moneyB.accounts.some((a) => a.displayName === "B-Only Bank")).toBe(true);
    expect(moneyB.accounts.some((a) => a.displayName === "A-Only Bank")).toBe(false);
  });
});
