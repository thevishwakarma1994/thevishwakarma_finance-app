import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../src/api/app.js";
import { openPostgresDatabase } from "../../src/db/pg/client.js";
import {
  applyPostgresMigrations,
  postgresMigrationsDir,
  truncatePostgresData,
} from "../../src/db/pg/migrate.js";
import { closeDatabase, type PostgresHandles } from "../../src/db/client.js";
import { persistBatch } from "../../src/db/persistBatch.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { home } from "../../src/db/reads.js";
import { persistGeneratedInstances } from "../../src/db/generateObligations.js";
import { newId } from "../../src/domain/ids.js";
import { utcNowIso } from "../../src/domain/calendar/kolkata.js";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { MAX_SAFE_PAISE, paise } from "../../src/domain/money/paise.js";
import type { VerifyIdToken } from "../../src/api/auth/guard.js";
import { eq } from "drizzle-orm";
import { schema } from "../../src/db/pg/schema.js";

const postgresUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
const describePg = postgresUrl ? describe : describe.skip;

const verifyIdToken: VerifyIdToken = async (token) => {
  if (token === "invalid") throw new Error("rejected");
  return {
    uid: token,
    email: `${token}@example.test`,
    displayName: token,
  };
};

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
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describePg("Stage 15 PostgreSQL persistence contract", () => {
  let handles: PostgresHandles;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    handles = openPostgresDatabase(postgresUrl);
    await applyPostgresMigrations(handles);
    app = createApp(handles, { verifyIdToken });
  });

  beforeEach(async () => {
    await truncatePostgresData(handles);
  });

  afterAll(async () => {
    await closeDatabase(handles);
  });

  async function provision(token: string) {
    const response = await api(app, token, "/api/me");
    expect(response.status).toBe(200);
    return json<{ userId: string; workspaceId: string }>(response);
  }

  async function createBank(token: string, name: string) {
    const response = await api(app, token, "/api/accounts", {
      method: "POST",
      body: JSON.stringify({ displayName: name, kind: "bank" }),
    });
    expect(response.status).toBe(200);
    return json<{ id: string }>(response);
  }

  it("A/B — first-user provisioning is idempotent", async () => {
    const first = await provision("user-a");
    const second = await provision("user-a");
    expect(second.userId).toBe(first.userId);
    expect(second.workspaceId).toBe(first.workspaceId);
    const users = await handles.db.select().from(schema.users);
    expect(users).toHaveLength(1);
  });

  it("C/P — second user is isolated; cross-workspace IDs are not found", async () => {
    const alice = await provision("alice");
    const bob = await provision("bob");
    expect(alice.workspaceId).not.toBe(bob.workspaceId);

    const aliceBank = await createBank("alice", "Alice Bank");
    const bobSee = await api(app, "bob", `/api/accounts`);
    const bobAccounts = await json<{ accounts: Array<{ id: string }> }>(bobSee);
    expect(bobAccounts.accounts.map((row) => row.id)).not.toContain(aliceBank.id);

    const expense = await api(app, "bob", "/api/commands/expense", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        accountId: aliceBank.id,
        allocations: [{ categoryId: "missing", amountPaise: 100 }],
      }),
    });
    expect(expense.status).toBe(404);
  });

  it("D/E/F/Q/R — opening, income, expense keep integer paise and DATE text", async () => {
    await provision("navin");
    const bank = await createBank("navin", "HDFC");
    const grocery = await json<{ id: string }>(
      await api(app, "navin", "/api/categories", {
        method: "POST",
        body: JSON.stringify({ name: "Grocery" }),
      }),
    );

    const opening = await api(app, "navin", "/api/commands/opening", {
      method: "POST",
      body: JSON.stringify({
        accountId: bank.id,
        effectiveOn: "2026-08-01",
        balancePaise: 5_000_000,
      }),
    });
    expect(opening.status).toBe(200);

    const income = await api(app, "navin", "/api/commands/income", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-05",
        amountPaise: 1,
        accountId: bank.id,
        kind: "other",
      }),
    });
    expect(income.status).toBe(200);

    const expense = await api(app, "navin", "/api/commands/expense", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        accountId: bank.id,
        allocations: [{ categoryId: grocery.id, amountPaise: 1 }],
      }),
    });
    expect(expense.status).toBe(200);

    const me = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const snapshot = await loadSnapshot(handles, me.workspaceId);
    expect(snapshot.accounts[0]?.balancePaise).toBe(5_000_000);
    const incomeEvent = snapshot.events.find((event) => event.meaning === "income");
    expect(incomeEvent?.amountPaise).toBe(1);
    expect(incomeEvent?.occurredOn).toBe("2026-08-05");
    expect(snapshot.openings[0]?.effectiveOn).toBe("2026-08-01");
  });

  it("G — transfer is atomic; failed transfer writes nothing extra", async () => {
    await provision("navin");
    const from = await createBank("navin", "From");
    const to = await createBank("navin", "To");
    await api(app, "navin", "/api/commands/opening", {
      method: "POST",
      body: JSON.stringify({ accountId: from.id, effectiveOn: "2026-08-01", balancePaise: 10_000 }),
    });
    const me = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const before = (await loadSnapshot(handles, me.workspaceId)).events.length;

    const ok = await api(app, "navin", "/api/commands/transfer", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        amountPaise: 4_000,
        fromAccountId: from.id,
        toAccountId: to.id,
      }),
    });
    expect(ok.status).toBe(200);
    const mid = await loadSnapshot(handles, me.workspaceId);
    expect(mid.accounts.find((row) => row.id === from.id)?.balancePaise).toBe(6_000);
    expect(mid.accounts.find((row) => row.id === to.id)?.balancePaise).toBe(4_000);

    const fail = await api(app, "navin", "/api/commands/transfer", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        amountPaise: 9_999_999,
        fromAccountId: from.id,
        toAccountId: to.id,
      }),
    });
    expect(fail.status).toBe(409);
    const after = await loadSnapshot(handles, me.workspaceId);
    expect(after.events.length).toBe(mid.events.length);
    expect(after.events.length).toBe(before + 1);
  });

  it("H — card spend assigns a billing cycle", async () => {
    await provision("navin");
    const cardRes = await api(app, "navin", "/api/cards", {
      method: "POST",
      body: JSON.stringify({
        displayName: "HDFC Millennia",
        issuer: "HDFC",
        statementDay: 5,
        dueDaysAfterStatement: 20,
      }),
    });
    expect(cardRes.status).toBe(200);
    const card = await json<{ id: string }>(cardRes);
    const cat = await json<{ id: string }>(
      await api(app, "navin", "/api/categories", {
        method: "POST",
        body: JSON.stringify({ name: "Grocery" }),
      }),
    );
    const spend = await api(app, "navin", "/api/commands/card-spend", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-10",
        creditCardId: card.id,
        allocations: [{ categoryId: cat.id, amountPaise: 250_000 }],
      }),
    });
    expect(spend.status).toBe(200);
    const body = await json<{ billingCycleId: string | null }>(spend);
    expect(body.billingCycleId).toBeTruthy();
  });

  it("I/J/K — split, settlement+reservation, surplus", async () => {
    await provision("navin");
    const bank = await createBank("navin", "HDFC");
    await api(app, "navin", "/api/commands/opening", {
      method: "POST",
      body: JSON.stringify({ accountId: bank.id, effectiveOn: "2026-08-01", balancePaise: 1_000_000 }),
    });
    const person = await json<{ id: string }>(
      await api(app, "navin", "/api/people", {
        method: "POST",
        body: JSON.stringify({ name: "Rahul" }),
      }),
    );
    const cat = await json<{ id: string }>(
      await api(app, "navin", "/api/categories", {
        method: "POST",
        body: JSON.stringify({ name: "Dinner" }),
      }),
    );
    const split = await api(app, "navin", "/api/commands/split", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        amountPaise: 200_000,
        source: { type: "account", accountId: bank.id },
        userSharePaise: 100_000,
        personShares: [{ personId: person.id, amountPaise: 100_000 }],
        allocations: [{ categoryId: cat.id, amountPaise: 100_000 }],
      }),
    });
    expect(split.status).toBe(200);
    const me = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const afterSplit = await loadSnapshot(handles, me.workspaceId);
    const claim = afterSplit.claims[0];
    expect(claim?.openAmountPaise).toBe(100_000);

    const settle = await api(app, "navin", "/api/commands/receive-settlement", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        accountId: bank.id,
        personId: person.id,
        amountPaise: 100_000,
        allocations: [{ claimId: claim!.id, amountPaise: 100_000 }],
      }),
    });
    expect(settle.status).toBe(200);
    const afterSettle = await loadSnapshot(handles, me.workspaceId);
    expect(afterSettle.claims[0]?.status).toBe("settled");

    const card = await json<{ id: string }>(
      await api(app, "navin", "/api/cards", {
        method: "POST",
        body: JSON.stringify({
          displayName: "HDFC Millennia",
          issuer: "HDFC",
          statementDay: 5,
          dueDaysAfterStatement: 20,
        }),
      }),
    );
    const cardSplit = await api(app, "navin", "/api/commands/split", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        amountPaise: 400_000,
        source: { type: "card", creditCardId: card.id },
        userSharePaise: 150_000,
        personShares: [{ personId: person.id, amountPaise: 250_000 }],
        allocations: [{ categoryId: cat.id, amountPaise: 150_000 }],
      }),
    });
    expect(cardSplit.status).toBe(200);
    const afterCardSplit = await loadSnapshot(handles, me.workspaceId);
    const cardClaim = afterCardSplit.claims.find((item) => item.status === "open");
    expect(cardClaim?.openAmountPaise).toBe(250_000);

    const collect = await api(app, "navin", "/api/commands/receive-settlement", {
      method: "POST",
      body: JSON.stringify({
        occurredOn: "2026-08-16",
        accountId: bank.id,
        personId: person.id,
        amountPaise: 300_000,
        allocations: [{ claimId: cardClaim!.id, amountPaise: 250_000 }],
      }),
    });
    expect(collect.status).toBe(200);
    const afterCollect = await loadSnapshot(handles, me.workspaceId);
    expect(afterCollect.reservations[0]?.remainingPaise).toBe(250_000);
    const surplus = afterCollect.surplusCases.find((item) => item.status === "pending");
    expect(surplus?.amountPaise).toBe(50_000);

    const resolved = await api(app, "navin", "/api/commands/resolve-surplus", {
      method: "POST",
      body: JSON.stringify({
        surplusCaseId: surplus!.id,
        resolution: "treat_as_mine_correction",
        confirmed: true,
      }),
    });
    expect(resolved.status).toBe(200);
    const afterResolve = await loadSnapshot(handles, me.workspaceId);
    expect(afterResolve.surplusCases.find((item) => item.id === surplus!.id)?.status).toBe("resolved");
  });

  it("L/M — Safe-to-Spend snapshot and write-free affordability", async () => {
    await provision("navin");
    const bank = await createBank("navin", "HDFC");
    await json<{ id: string }>(
      await api(app, "navin", "/api/categories", {
        method: "POST",
        body: JSON.stringify({ name: "Grocery" }),
      }),
    );
    await api(app, "navin", "/api/commands/opening", {
      method: "POST",
      body: JSON.stringify({ accountId: bank.id, effectiveOn: "2026-08-01", balancePaise: 2_000_000 }),
    });
    const me = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const view = await home(handles, me.workspaceId, isoDate("2026-08-16"));
    expect(view.liquidTotal).toBe(2_000_000);
    const before = (await loadSnapshot(handles, me.workspaceId)).events.length;
    const sim = await api(app, "navin", "/api/commands/simulate-affordability", {
      method: "POST",
      body: JSON.stringify({ amountPaise: 100_000, funding: { accountId: bank.id } }),
    });
    expect(sim.status).toBe(200);
    const after = (await loadSnapshot(handles, me.workspaceId)).events.length;
    expect(after).toBe(before);
  });

  it("N — obligation materialization is idempotent", async () => {
    await provision("navin");
    const created = await api(app, "navin", "/api/commands/obligation-templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Rent",
        priority: "must_pay",
        dayOfMonth: 5,
        amountPaise: 100_000,
        effectiveFrom: "2026-01-01",
      }),
    });
    expect(created.status).toBe(200);
    const me = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const first = await persistGeneratedInstances(handles, me.workspaceId, isoDate("2026-08-16"));
    const second = await persistGeneratedInstances(handles, me.workspaceId, isoDate("2026-08-16"));
    expect(second).toBe(0);
    expect(first).toBeGreaterThanOrEqual(0);
    const snapshot = await loadSnapshot(handles, me.workspaceId);
    const dues = snapshot.obligationInstances.map((row) => `${row.templateId}:${row.dueOn}`);
    expect(new Set(dues).size).toBe(dues.length);
  });

  it("O — failed persistBatch rolls back sibling rows", async () => {
    await provision("navin");
    const me = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const eventId = newId();
    const before = (await loadSnapshot(handles, me.workspaceId)).events.length;
    await expect(
      persistBatch(handles, me.workspaceId, {
        events: [
          {
            id: eventId,
            meaning: "income",
            occurredOn: isoDate("2026-08-16"),
            capturedAt: utcNowIso(),
            amountPaise: paise(100),
            accountId: "missing-account",
            creditCardId: null,
            loanId: null,
            billingCycleId: null,
            fundingCycleId: null,
            obligationInstanceId: null,
            categoryId: null,
            channel: null,
            merchant: null,
            notes: null,
            reversalOfEventId: null,
          },
        ],
        postings: [
          {
            id: newId(),
            eventId,
            amountPaise: paise(100),
            accountId: "missing-account",
            creditCardId: null,
            loanId: null,
            pnl: null,
            categoryId: null,
            claimId: null,
            billingCycleId: null,
          },
          {
            id: newId(),
            eventId,
            amountPaise: paise(100),
            accountId: null,
            creditCardId: null,
            loanId: null,
            pnl: "income_other",
            categoryId: null,
            claimId: null,
            billingCycleId: null,
          },
        ],
        openings: [],
      }),
    ).rejects.toThrow();
    const after = await loadSnapshot(handles, me.workspaceId);
    expect(after.events.length).toBe(before);
    const leftover = await handles.db
      .select()
      .from(schema.financialEvents)
      .where(eq(schema.financialEvents.id, eventId));
    expect(leftover).toHaveLength(0);
  });

  it("migration is idempotent; failed SQL is rolled back and not recorded", async () => {
    const before = await handles.pool.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
    );
    expect(before.rows).toHaveLength(1);
    await applyPostgresMigrations(handles);
    const after = await handles.pool.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations ORDER BY filename",
    );
    expect(after.rows).toEqual(before.rows);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-pg-mig-"));
    fs.copyFileSync(path.join(postgresMigrationsDir(), "0000_init.sql"), path.join(dir, "0000_init.sql"));
    fs.writeFileSync(path.join(dir, "0001_fail.sql"), "DO $$ BEGIN RAISE EXCEPTION 'boom'; END $$;");
    await expect(applyPostgresMigrations(handles, dir)).rejects.toThrow();
    const recorded = await handles.pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(recorded.rows.map((row) => row.filename)).toEqual(["0000_init.sql"]);

    const tamperDir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-pg-tamper-"));
    fs.writeFileSync(path.join(tamperDir, "0000_init.sql"), "-- tampered\nSELECT 1;\n");
    await expect(applyPostgresMigrations(handles, tamperDir)).rejects.toThrow(/checksum/);
  });

  it("A–F — Paise BIGINT round-trip is exact and unsafe values are rejected", async () => {
    await provision("navin");
    const bank = await createBank("navin", "HDFC");
    const me = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));

    async function persistIncome(amount: number) {
      const eventId = newId();
      await persistBatch(handles, me.workspaceId, {
        events: [
          {
            id: eventId,
            meaning: "income",
            occurredOn: isoDate("2026-08-16"),
            capturedAt: utcNowIso(),
            amountPaise: paise(amount),
            accountId: bank.id,
            creditCardId: null,
            loanId: null,
            billingCycleId: null,
            fundingCycleId: null,
            obligationInstanceId: null,
            categoryId: null,
            channel: null,
            merchant: null,
            notes: null,
            reversalOfEventId: null,
          },
        ],
        postings: [
          {
            id: newId(),
            eventId,
            amountPaise: paise(amount),
            accountId: bank.id,
            creditCardId: null,
            loanId: null,
            pnl: null,
            categoryId: null,
            claimId: null,
            billingCycleId: null,
          },
          {
            id: newId(),
            eventId,
            amountPaise: paise(amount),
            accountId: null,
            creditCardId: null,
            loanId: null,
            pnl: "income_other",
            categoryId: null,
            claimId: null,
            billingCycleId: null,
          },
        ],
        openings: [],
      });
      return eventId;
    }

    async function rawAmount(eventId: string) {
      const result = await handles.pool.query<{ amount: string }>(
        "SELECT amount_paise::text AS amount FROM financial_events WHERE id = $1",
        [eventId],
      );
      return result.rows[0]?.amount;
    }

    const a = await persistIncome(7_920_000);
    expect((await loadSnapshot(handles, me.workspaceId)).events.find((event) => event.id === a)?.amountPaise).toBe(
      7_920_000,
    );
    expect(await rawAmount(a)).toBe("7920000");

    await truncatePostgresData(handles);
    await provision("navin");
    const bankB = await createBank("navin", "HDFC");
    const meB = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const b = newId();
    await persistBatch(handles, meB.workspaceId, {
      events: [
        {
          id: b,
          meaning: "income",
          occurredOn: isoDate("2026-08-16"),
          capturedAt: utcNowIso(),
          amountPaise: paise(1),
          accountId: bankB.id,
          creditCardId: null,
          loanId: null,
          billingCycleId: null,
          fundingCycleId: null,
          obligationInstanceId: null,
          categoryId: null,
          channel: null,
          merchant: null,
          notes: null,
          reversalOfEventId: null,
        },
      ],
      postings: [
        {
          id: newId(),
          eventId: b,
          amountPaise: paise(1),
          accountId: bankB.id,
          creditCardId: null,
          loanId: null,
          pnl: null,
          categoryId: null,
          claimId: null,
          billingCycleId: null,
        },
        {
          id: newId(),
          eventId: b,
          amountPaise: paise(1),
          accountId: null,
          creditCardId: null,
          loanId: null,
          pnl: "income_other",
          categoryId: null,
          claimId: null,
          billingCycleId: null,
        },
      ],
      openings: [],
    });
    expect((await loadSnapshot(handles, meB.workspaceId)).events.find((event) => event.id === b)?.amountPaise).toBe(1);
    expect(
      (
        await handles.pool.query<{ amount: string }>(
          "SELECT amount_paise::text AS amount FROM financial_events WHERE id = $1",
          [b],
        )
      ).rows[0]?.amount,
    ).toBe("1");

    await truncatePostgresData(handles);
    await provision("navin");
    const bankC = await createBank("navin", "HDFC");
    const meC = await json<{ workspaceId: string }>(await api(app, "navin", "/api/me"));
    const c = newId();
    await persistBatch(handles, meC.workspaceId, {
      events: [
        {
          id: c,
          meaning: "income",
          occurredOn: isoDate("2026-08-16"),
          capturedAt: utcNowIso(),
          amountPaise: paise(MAX_SAFE_PAISE),
          accountId: bankC.id,
          creditCardId: null,
          loanId: null,
          billingCycleId: null,
          fundingCycleId: null,
          obligationInstanceId: null,
          categoryId: null,
          channel: null,
          merchant: null,
          notes: null,
          reversalOfEventId: null,
        },
      ],
      postings: [
        {
          id: newId(),
          eventId: c,
          amountPaise: paise(MAX_SAFE_PAISE),
          accountId: bankC.id,
          creditCardId: null,
          loanId: null,
          pnl: null,
          categoryId: null,
          claimId: null,
          billingCycleId: null,
        },
        {
          id: newId(),
          eventId: c,
          amountPaise: paise(MAX_SAFE_PAISE),
          accountId: null,
          creditCardId: null,
          loanId: null,
          pnl: "income_other",
          categoryId: null,
          claimId: null,
          billingCycleId: null,
        },
      ],
      openings: [],
    });
    expect((await loadSnapshot(handles, meC.workspaceId)).events.find((event) => event.id === c)?.amountPaise).toBe(
      MAX_SAFE_PAISE,
    );
    expect(
      (
        await handles.pool.query<{ amount: string }>(
          "SELECT amount_paise::text AS amount FROM financial_events WHERE id = $1",
          [c],
        )
      ).rows[0]?.amount,
    ).toBe(String(MAX_SAFE_PAISE));

    await truncatePostgresData(handles);
    const negativeWs = await provision("navin");
    const negativeId = newId();
    await handles.pool.query(
      `INSERT INTO financial_events (
        id, workspace_id, meaning, occurred_on, captured_at, amount_paise
      ) VALUES ($1, $2, 'income', '2026-08-16', $3, $4)`,
      [negativeId, negativeWs.workspaceId, utcNowIso(), "-125000"],
    );
    expect(
      (await loadSnapshot(handles, negativeWs.workspaceId)).events.find((event) => event.id === negativeId)
        ?.amountPaise,
    ).toBe(-125_000);

    await truncatePostgresData(handles);
    const unsafeWs = await provision("navin");
    const unsafeId = newId();
    await handles.pool.query(
      `INSERT INTO financial_events (
        id, workspace_id, meaning, occurred_on, captured_at, amount_paise
      ) VALUES ($1, $2, 'income', '2026-08-16', $3, $4)`,
      [unsafeId, unsafeWs.workspaceId, utcNowIso(), "9007199254740993"],
    );
    const stored = await handles.pool.query<{ amount: string }>(
      "SELECT amount_paise::text AS amount FROM financial_events WHERE id = $1",
      [unsafeId],
    );
    expect(stored.rows[0]?.amount).toBe("9007199254740993");
    await expect(loadSnapshot(handles, unsafeWs.workspaceId)).rejects.toThrow(/safe integer|exceeds/);
  });
});
