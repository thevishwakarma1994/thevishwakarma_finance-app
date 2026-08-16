import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/api/app.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, LEGACY_WORKSPACE_NAME, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { users, workspaces, workspaceMemberships } from "../../src/db/schema.js";
import { todayKolkata } from "../../src/domain/calendar/kolkata.js";
import type { VerifyIdToken } from "../../src/api/auth/guard.js";

const verifyIdToken: VerifyIdToken = async (token) => {
  if (token === "invalid" || token === "revoked" || token === "firebase-disabled") {
    throw new Error("rejected");
  }
  return {
    uid: token,
    email: `${token}@example.test`,
    displayName: token,
  };
};

function setup() {
  const handles = openMemoryDatabase();
  applyMigrations(handles);
  const app = createApp(handles, { verifyIdToken });
  return { handles, app };
}

async function api(
  app: ReturnType<typeof createApp>,
  token: string | null,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.method && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("origin", "http://localhost:5173");
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return app.request(path, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function me(app: ReturnType<typeof createApp>, token: string) {
  const response = await api(app, token, "/api/me");
  expect(response.status).toBe(200);
  return json<{ authenticated: boolean; userId: string; workspaceId: string }>(response);
}

async function createBank(app: ReturnType<typeof createApp>, token: string, name: string) {
  const response = await api(app, token, "/api/accounts", {
    method: "POST",
    body: JSON.stringify({ displayName: name, kind: "bank" }),
  });
  expect(response.status).toBe(200);
  return json<{ id: string }>(response);
}

async function createPerson(app: ReturnType<typeof createApp>, token: string, name: string) {
  const response = await api(app, token, "/api/people", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(200);
  return json<{ id: string }>(response);
}

async function createCard(app: ReturnType<typeof createApp>, token: string, name: string) {
  const response = await api(app, token, "/api/cards", {
    method: "POST",
    body: JSON.stringify({
      displayName: name,
      issuer: "HDFC",
      statementDay: 5,
      dueDaysAfterStatement: 20,
    }),
  });
  expect(response.status).toBe(200);
  return json<{ id: string }>(response);
}

describe("stage 14 firebase auth and workspace isolation", () => {
  const dbs: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of dbs.splice(0)) handles.sqlite.close();
  });

  it("A / P — first login provisions user, personal workspace, owner membership", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const session = await me(ctx.app, "A");
    expect(session.authenticated).toBe(true);
    expect(session.userId).toBeTruthy();
    expect(session.workspaceId).toBeTruthy();

    const user = ctx.handles.db.select().from(users).where(eq(users.firebaseUid, "A")).get();
    expect(user?.id).toBe(session.userId);
    expect(user?.status).toBe("active");
    const membership = ctx.handles.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, session.userId))
      .get();
    expect(membership?.workspaceId).toBe(session.workspaceId);
    expect(membership?.role).toBe("owner");
    const workspace = ctx.handles.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, session.workspaceId))
      .get();
    expect(workspace?.name).toBe("Personal");
    expect(session.workspaceId).not.toBe(getSoleWorkspaceId(ctx.handles));
  });

  it("B — repeated login reuses the same user and workspace", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const first = await me(ctx.app, "A");
    const second = await me(ctx.app, "A");
    expect(second.userId).toBe(first.userId);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(ctx.handles.db.select().from(users).all()).toHaveLength(1);
    const personal = ctx.handles.db
      .select()
      .from(workspaces)
      .all()
      .filter((row) => row.name === "Personal");
    expect(personal).toHaveLength(1);
    const memberships = ctx.handles.db.select().from(workspaceMemberships).all();
    expect(memberships).toHaveLength(1);
  });

  it("C — second user gets a different empty personal workspace", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const a = await me(ctx.app, "A");
    const b = await me(ctx.app, "B");
    expect(b.userId).not.toBe(a.userId);
    expect(b.workspaceId).not.toBe(a.workspaceId);
    const legacy = getSoleWorkspaceId(ctx.handles);
    expect(a.workspaceId).not.toBe(legacy);
    expect(b.workspaceId).not.toBe(legacy);
    const legacyRow = ctx.handles.db.select().from(workspaces).where(eq(workspaces.id, legacy)).get();
    expect(legacyRow?.name).toBe(LEGACY_WORKSPACE_NAME);
    const aAccounts = await json<{ accounts: { id: string }[] }>(
      await api(ctx.app, "A", "/api/accounts"),
    );
    const bAccounts = await json<{ accounts: { id: string }[] }>(
      await api(ctx.app, "B", "/api/accounts"),
    );
    expect(aAccounts.accounts).toEqual([]);
    expect(bAccounts.accounts).toEqual([]);
  });

  it("D / E — account reads stay inside the authenticated workspace", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    await me(ctx.app, "A");
    await me(ctx.app, "B");
    const aBank = await createBank(ctx.app, "A", "A Bank");
    const bBank = await createBank(ctx.app, "B", "B Bank");
    const aAccounts = await json<{ accounts: { id: string; displayName: string }[] }>(
      await api(ctx.app, "A", "/api/accounts"),
    );
    const bAccounts = await json<{ accounts: { id: string; displayName: string }[] }>(
      await api(ctx.app, "B", "/api/accounts"),
    );
    expect(aAccounts.accounts.map((row) => row.id)).toEqual([aBank.id]);
    expect(bAccounts.accounts.map((row) => row.id)).toEqual([bBank.id]);
    expect(aAccounts.accounts.some((row) => row.id === bBank.id)).toBe(false);
  });

  it("F — rejects a cross-workspace account id", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    await me(ctx.app, "A");
    await me(ctx.app, "B");
    const bBank = await createBank(ctx.app, "B", "B Bank");
    const response = await api(ctx.app, "A", "/api/commands/income", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: todayKolkata(),
        amountPaise: 1000,
        accountId: bBank.id,
        kind: "other",
        commit: true,
      }),
    });
    expect(response.status).toBe(404);
    expect((await json<{ error: string }>(response)).error).toBe("account_not_found");
  });

  it("G — rejects a cross-workspace card id", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    await me(ctx.app, "A");
    await me(ctx.app, "B");
    const bCard = await createCard(ctx.app, "B", "B Card");
    const spend = await api(ctx.app, "A", "/api/commands/card-spend", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: todayKolkata(),
        creditCardId: bCard.id,
        amountPaise: 5000,
        allocations: [],
        commit: true,
      }),
    });
    expect(spend.status).toBe(404);
    expect((await json<{ error: string }>(spend)).error).toBe("card_not_found");
    const read = await api(ctx.app, "A", `/api/cards/${bCard.id}`);
    expect(read.status).toBe(404);
  });

  it("H — rejects a cross-workspace person and claim id", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    await me(ctx.app, "A");
    await me(ctx.app, "B");
    const aBank = await createBank(ctx.app, "A", "A Bank");
    const bBank = await createBank(ctx.app, "B", "B Bank");
    await api(ctx.app, "B", "/api/commands/opening", {
      method: "POST",
      body: JSON.stringify({
        accountId: bBank.id,
        effectiveOn: todayKolkata(),
        balancePaise: 50_000,
        commit: true,
      }),
    });
    const bPerson = await createPerson(ctx.app, "B", "Sam");
    const lend = await api(ctx.app, "B", "/api/commands/lend", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: todayKolkata(),
        accountId: bBank.id,
        personId: bPerson.id,
        amountPaise: 10_000,
        commit: true,
      }),
    });
    expect(lend.status).toBe(200);
    const person = await json<{ openClaims: { id: string }[] }>(
      await api(ctx.app, "B", `/api/people/${bPerson.id}`),
    );
    const claimId = person.openClaims[0]?.id;
    expect(claimId).toBeTruthy();

    const personWrite = await api(ctx.app, "A", "/api/commands/lend", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: todayKolkata(),
        accountId: aBank.id,
        personId: bPerson.id,
        amountPaise: 1000,
        commit: true,
      }),
    });
    expect(personWrite.status).toBe(404);
    expect((await json<{ error: string }>(personWrite)).error).toBe("person_not_found");

    const claimWrite = await api(ctx.app, "A", "/api/commands/receive-settlement", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: todayKolkata(),
        accountId: aBank.id,
        personId: bPerson.id,
        amountPaise: 1000,
        allocations: [{ claimId, amountPaise: 1000 }],
        commit: true,
      }),
    });
    expect(claimWrite.status).toBe(404);
    const personRead = await api(ctx.app, "A", `/api/people/${bPerson.id}`);
    expect(personRead.status).toBe(404);
  });

  it("I — rejects a cross-workspace cycle id", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    await me(ctx.app, "A");
    await me(ctx.app, "B");
    const bCard = await createCard(ctx.app, "B", "B Card");
    const category = await api(ctx.app, "B", "/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Grocery" }),
    });
    expect(category.status).toBe(200);
    const categoryId = (await json<{ id: string }>(category)).id;
    const spend = await api(ctx.app, "B", "/api/commands/card-spend", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: todayKolkata(),
        creditCardId: bCard.id,
        allocations: [{ categoryId, amountPaise: 12_000 }],
        commit: true,
      }),
    });
    expect(spend.status).toBe(200);
    const cards = await json<{ cards: { currentCycle: { id: string } | null }[] }>(
      await api(ctx.app, "B", "/api/cards"),
    );
    const cycleId = cards.cards[0]?.currentCycle?.id;
    expect(cycleId).toBeTruthy();
    const confirm = await api(ctx.app, "A", "/api/commands/confirm-statement", {
      method: "POST",
      body: JSON.stringify({
        cycleId,
        actualStatementAmountPaise: 12_000,
        actualStatementOn: todayKolkata(),
        actualDueOn: todayKolkata(),
      }),
    });
    expect(confirm.status).toBe(404);
    expect((await json<{ error: string }>(confirm)).error).toBe("cycle_not_found");
    const read = await api(ctx.app, "A", `/api/cycles/${cycleId}`);
    expect(read.status).toBe(404);
  });

  it("J — rejects a cross-workspace obligation id", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    await me(ctx.app, "A");
    await me(ctx.app, "B");
    const aBank = await createBank(ctx.app, "A", "A Bank");
    const created = await api(ctx.app, "B", "/api/commands/obligation-one-off", {
      method: "POST",
      body: JSON.stringify({
        name: "B rent",
        dueOn: todayKolkata(),
        amountPaise: 25_000,
        priority: "must_pay",
      }),
    });
    expect(created.status).toBe(200);
    const instanceId = (await json<{ id: string }>(created)).id;
    const pay = await api(ctx.app, "A", "/api/commands/pay-obligation", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: todayKolkata(),
        instanceId,
        accountId: aBank.id,
        amountPaise: 25_000,
        commit: true,
      }),
    });
    expect(pay.status).toBe(404);
    expect((await json<{ error: string }>(pay)).error).toBe("obligation_not_found");
    const read = await api(ctx.app, "A", `/api/obligations/${instanceId}`);
    expect(read.status).toBe(404);
  });

  it("K / L / M — Home, STS, and affordability stay on the authenticated workspace", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    await me(ctx.app, "A");
    await me(ctx.app, "B");
    const aBank = await createBank(ctx.app, "A", "A Bank");
    const bBank = await createBank(ctx.app, "B", "B Bank");
    await api(ctx.app, "A", "/api/commands/opening", {
      method: "POST",
      body: JSON.stringify({
        accountId: aBank.id,
        effectiveOn: todayKolkata(),
        balancePaise: 5_000_000,
        commit: true,
      }),
    });
    await api(ctx.app, "B", "/api/commands/opening", {
      method: "POST",
      body: JSON.stringify({
        accountId: bBank.id,
        effectiveOn: todayKolkata(),
        balancePaise: 100_000,
        commit: true,
      }),
    });
    const aHome = await json<{
      currentCycleSafeToSpend: number;
      accounts: { accountId: string }[];
    }>(await api(ctx.app, "A", "/api/home"));
    const bHome = await json<{
      currentCycleSafeToSpend: number;
      accounts: { accountId: string }[];
    }>(await api(ctx.app, "B", "/api/home"));
    expect(aHome.accounts.map((row) => row.accountId)).toEqual([aBank.id]);
    expect(bHome.accounts.map((row) => row.accountId)).toEqual([bBank.id]);
    expect(aHome.currentCycleSafeToSpend).toBe(5_000_000);
    expect(bHome.currentCycleSafeToSpend).toBe(100_000);

    const category = await api(ctx.app, "A", "/api/categories", {
      method: "POST",
      body: JSON.stringify({ name: "Grocery" }),
    });
    expect(category.status).toBe(200);

    const aAfford = await api(ctx.app, "A", "/api/commands/simulate-affordability", {
      method: "POST",
      body: JSON.stringify({ amountPaise: 10_000, funding: { accountId: aBank.id } }),
    });
    expect(aAfford.status).toBe(200);
    const aAfter = await json<{ afterCurrent: { currentCycleSafeToSpend: number } }>(aAfford);
    expect(aAfter.afterCurrent.currentCycleSafeToSpend).toBe(4_990_000);

    const crossAfford = await api(ctx.app, "A", "/api/commands/simulate-affordability", {
      method: "POST",
      body: JSON.stringify({ amountPaise: 10_000, funding: { accountId: bBank.id } }),
    });
    expect(crossAfford.status).toBe(404);
  });

  it("N — missing Firebase token is 401", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const response = await api(ctx.app, null, "/api/me");
    expect(response.status).toBe(401);
    expect((await json<{ error: string }>(response)).error).toBe("unauthenticated");
  });

  it("O — invalid Firebase token is 401", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const response = await api(ctx.app, "invalid", "/api/accounts");
    expect(response.status).toBe(401);
    const body = await json<{ error: string; message: string }>(response);
    expect(body.error).toBe("unauthenticated");
    expect(body.message).toBe("Invalid Firebase token");
  });

  it("revoked Firebase token is 401 without leaking verifier internals", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const response = await api(ctx.app, "revoked", "/api/accounts");
    expect(response.status).toBe(401);
    const body = await json<{ error: string; message: string }>(response);
    expect(body.error).toBe("unauthenticated");
    expect(body.message).toBe("Invalid Firebase token");
    expect(body.message.toLowerCase()).not.toContain("revok");
  });

  it("disabled Firebase identity is 401 without leaking verifier internals", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const response = await api(ctx.app, "firebase-disabled", "/api/accounts");
    expect(response.status).toBe(401);
    const body = await json<{ error: string; message: string }>(response);
    expect(body.error).toBe("unauthenticated");
    expect(body.message).toBe("Invalid Firebase token");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("firebase-disabled");
  });

  it("Q — disabled internal user is denied", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const session = await me(ctx.app, "A");
    ctx.handles.db.update(users).set({ status: "disabled" }).where(eq(users.id, session.userId)).run();
    const response = await api(ctx.app, "A", "/api/accounts");
    expect(response.status).toBe(403);
    expect((await json<{ error: string }>(response)).error).toBe("user_disabled");
    const missing = await api(ctx.app, null, "/api/accounts");
    expect(missing.status).toBe(401);
  });

  it("R — old password login endpoint is unavailable", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const missing = await api(ctx.app, null, "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "changeme" }),
    });
    expect(missing.status).toBe(401);
    const authed = await api(ctx.app, "A", "/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "changeme" }),
    });
    expect(authed.status).toBe(404);
  });

  it("does not attach the legacy development workspace to a Firebase user", async () => {
    const ctx = setup();
    dbs.push(ctx.handles);
    const legacy = getSoleWorkspaceId(ctx.handles);
    const session = await me(ctx.app, "A");
    expect(session.workspaceId).not.toBe(legacy);
    const memberships = ctx.handles.db
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, legacy))
      .all();
    expect(memberships).toHaveLength(0);
  });
});
