import { count, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { isoDate } from "../../src/domain/calendar/isoDate.js";
import { DomainError } from "../../src/domain/ledger/types.js";
import { personPosition } from "../../src/domain/people/position.js";
import { openMemoryDatabase, type SqliteHandles } from "../../src/db/client.js";
import { applyMigrations, getSoleWorkspaceId } from "../../src/db/migrate.js";
import { loadSnapshot } from "../../src/db/loadSnapshot.js";
import { listActivity, listPeople, monthReview, personDetail } from "../../src/db/reads.js";
import { claims, eventShares, financialEvents, postings } from "../../src/db/schema.js";
import { applyOpening } from "../../src/app/applyOpening.js";
import { recordSplit } from "../../src/app/recordSplit.js";
import { recordCardSpend } from "../../src/app/recordCardSpend.js";
import { lendMoney } from "../../src/app/lendMoney.js";
import { borrowMoney } from "../../src/app/borrowMoney.js";
import { createCard, updateCard } from "../../src/app/cards.js";
import { createPerson, updatePerson } from "../../src/app/people.js";

const capturedAt = "2026-08-16T10:00:00.000Z";

async function setup() {
  const handles = openMemoryDatabase();
  await applyMigrations(handles);
  const workspaceId = await getSoleWorkspaceId(handles);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const hdfc = snapshot.accounts.find((account) => account.displayName === "HDFC");
  const grocery = snapshot.categories.find((category) => category.name === "Grocery");
  if (!hdfc || !grocery) throw new Error("Expected seeded HDFC and Grocery");
  await applyOpening(handles, { workspaceId }, {
    accountId: hdfc.id,
    effectiveOn: "2026-08-01",
    balancePaise: 5_000_000,
    commit: true,
  });
  const card = await createCard(handles, { workspaceId }, {
    displayName: "ICICI",
    issuer: "ICICI",
    mask: "8001",
    statementDay: 12,
    dueDaysAfterStatement: 18,
    defaultPaymentAccountId: hdfc.id,
  });
  const rahul = await createPerson(handles, { workspaceId }, { name: "Rahul" });
  const amit = await createPerson(handles, { workspaceId }, { name: "Amit" });
  return {
    handles,
    workspaceId,
    hdfcId: hdfc.id,
    groceryId: grocery.id,
    cardId: card.id,
    rahulId: rahul.id,
    amitId: amit.id,
  };
}

function tableCounts(handles: SqliteHandles, workspaceId: string) {
  return {
    events:
      handles.db
        .select({ value: count() })
        .from(financialEvents)
        .where(eq(financialEvents.workspaceId, workspaceId))
        .get()?.value ?? 0,
    postings:
      handles.db
        .select({ value: count() })
        .from(postings)
        .where(eq(postings.workspaceId, workspaceId))
        .get()?.value ?? 0,
    claims:
      handles.db
        .select({ value: count() })
        .from(claims)
        .where(eq(claims.workspaceId, workspaceId))
        .get()?.value ?? 0,
    shares:
      handles.db
        .select({ value: count() })
        .from(eventShares)
        .where(eq(eventShares.workspaceId, workspaceId))
        .get()?.value ?? 0,
  };
}

async function balance(handles: SqliteHandles, workspaceId: string, accountId: string): Promise<number> {
  const account = (await loadSnapshot(handles, workspaceId)).accounts.find((item) => item.id === accountId);
  if (!account) throw new Error("Account missing");
  return account.balancePaise;
}

describe("stage 9 people claims and shared ownership", () => {
  const contexts: SqliteHandles[] = [];
  afterEach(() => {
    for (const handles of contexts.splice(0)) handles.sqlite.close();
  });

  it("A — bank split conserves account, expense, claim, and shares", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 300_000,
      source: { type: "account", accountId: ctx.hdfcId },
      userSharePaise: 120_000,
      personShares: [{ personId: ctx.rahulId, amountPaise: 180_000 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 120_000 }],
      merchant: "Restaurant",
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(4_700_000);
    expect(snapshot.postings.find((posting) => posting.pnl === "expense")?.amountPaise).toBe(120_000);
    expect(snapshot.claims[0]?.originalAmountPaise).toBe(180_000);
    expect(snapshot.claims[0]?.kind).toBe("shared_bill");
    expect(snapshot.eventShares.reduce((sum, share) => sum + share.amountPaise, 0)).toBe(300_000);
    const activity = (await listActivity(ctx.handles, ctx.workspaceId)).find((event) => event.meaning === "split");
    expect(activity?.shares.map((share) => share.personName).sort()).toEqual(["Rahul", "You"]);
  });

  it("B — card split links the claim to the billing cycle", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const result = await recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 400_000,
      source: { type: "card", creditCardId: ctx.cardId },
      userSharePaise: 150_000,
      personShares: [{ personId: ctx.rahulId, amountPaise: 250_000 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 150_000 }],
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.postings.find((posting) => posting.creditCardId)?.amountPaise).toBe(400_000);
    expect(snapshot.postings.find((posting) => posting.pnl === "expense")?.amountPaise).toBe(150_000);
    expect(snapshot.claims[0]?.kind).toBe("card_share");
    expect(snapshot.claims[0]?.originalAmountPaise).toBe(250_000);
    expect(snapshot.claims[0]?.billingCycleId).toBe(result.billingCycleId);
  });

  it("C — other-owned default card spend creates a full claim and no expense", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await updateCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cardId: ctx.cardId,
      defaultOwnerPersonId: ctx.rahulId,
    });
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: ctx.cardId,
      amountPaise: 500_000,
      allocations: [],
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.postings.find((posting) => posting.creditCardId)?.amountPaise).toBe(500_000);
    expect(snapshot.postings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect(snapshot.claims[0]?.personId).toBe(ctx.rahulId);
    expect(snapshot.claims[0]?.originalAmountPaise).toBe(500_000);
    const activity = (await listActivity(ctx.handles, ctx.workspaceId)).find((event) => event.meaning === "spend_card");
    expect(activity?.otherOwned).toBe(true);
    expect(activity?.counterpartyName).toBe("Rahul");
  });

  it("D — overriding default owner to the user posts personal expense", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await updateCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cardId: ctx.cardId,
      defaultOwnerPersonId: ctx.rahulId,
    });
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: ctx.cardId,
      ownerPersonId: null,
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 500_000 }],
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.postings.find((posting) => posting.pnl === "expense")?.amountPaise).toBe(500_000);
    expect(snapshot.claims).toHaveLength(0);
  });

  it("E — multi-person split conserves exactly", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 600_000,
      source: { type: "account", accountId: ctx.hdfcId },
      userSharePaise: 200_000,
      personShares: [
        { personId: ctx.rahulId, amountPaise: 250_000 },
        { personId: ctx.amitId, amountPaise: 150_000 },
      ],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 200_000 }],
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(4_400_000);
    expect(snapshot.postings.find((posting) => posting.pnl === "expense")?.amountPaise).toBe(200_000);
    expect(snapshot.claims.map((claim) => claim.originalAmountPaise).sort()).toEqual([150_000, 250_000]);
    expect(snapshot.eventShares.reduce((sum, share) => sum + share.amountPaise, 0)).toBe(600_000);
  });

  it("F — lend decreases the account and opens a receivable without expense", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 200_000,
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(4_800_000);
    expect(snapshot.claims[0]?.kind).toBe("direct_loan");
    expect(snapshot.postings.some((posting) => posting.pnl === "expense")).toBe(false);
    expect((await listActivity(ctx.handles, ctx.workspaceId))[0]?.meaning).toBe("lend");
  });

  it("G — borrow increases the account and opens a payable without income", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await borrowMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 200_000,
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(5_200_000);
    expect(snapshot.claims[0]?.kind).toBe("borrowing");
    expect(snapshot.claims[0]?.direction).toBe("user_owes_them");
    expect(snapshot.postings.some((posting) => posting.pnl)).toBe(false);
    expect((await listActivity(ctx.handles, ctx.workspaceId))[0]?.meaning).toBe("borrow");
  });

  it("H — Month Review includes only the user share", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      amountPaise: 300_000,
      source: { type: "account", accountId: ctx.hdfcId },
      userSharePaise: 120_000,
      personShares: [{ personId: ctx.rahulId, amountPaise: 180_000 }],
      allocations: [{ categoryId: ctx.groceryId, amountPaise: 120_000 }],
      commit: true,
    });
    const review = await monthReview(ctx.handles, ctx.workspaceId, isoDate("2026-08-16"));
    expect(review.spentPaise).toBe(120_000);
  });

  it("I — person net is derived from open receivable and payable claims", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 300_000,
      commit: true,
    });
    await borrowMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 100_000,
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const position = personPosition(snapshot.claims, ctx.rahulId);
    expect(position.theyOwePaise).toBe(300_000);
    expect(position.youOwePaise).toBe(100_000);
    expect(position.netPaise).toBe(200_000);
    expect(position.openItemCount).toBe(2);
    const listed = (await listPeople(ctx.handles, ctx.workspaceId)).find((person) => person.id === ctx.rahulId);
    expect(listed?.group).toBe("they_owe_you");
    expect(listed?.netPaise).toBe(200_000);
  });

  it("J — person opening creates a claim without fake expense or income", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const before = tableCounts(ctx.handles, ctx.workspaceId);
    await applyOpening(ctx.handles, { workspaceId: ctx.workspaceId }, {
      personId: ctx.rahulId,
      effectiveOn: "2026-08-01",
      direction: "they_owe_user",
      amountPaise: 800_000,
      commit: true,
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.events).toHaveLength(before.events);
    expect(snapshot.claims[0]?.kind).toBe("direct_loan");
    expect(snapshot.claims[0]?.originalAmountPaise).toBe(800_000);
    expect(snapshot.openings.some((opening) => opening.kind === "person")).toBe(true);
    expect(snapshot.postings.some((posting) => posting.pnl)).toBe(false);
    const detail = await personDetail(ctx.handles, ctx.workspaceId, ctx.rahulId);
    expect(detail.hasOpening).toBe(true);
    expect(detail.netPaise).toBe(800_000);
  });

  it("K — changing card default owner does not rewrite earlier shares or claims", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await updateCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cardId: ctx.cardId,
      defaultOwnerPersonId: ctx.rahulId,
    });
    await recordCardSpend(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      creditCardId: ctx.cardId,
      amountPaise: 500_000,
      allocations: [],
      commit: true,
    });
    const before = await loadSnapshot(ctx.handles, ctx.workspaceId);
    const claimId = before.claims[0]?.id;
    const shareAmounts = before.eventShares.map((share) => share.amountPaise).sort();
    await updateCard(ctx.handles, { workspaceId: ctx.workspaceId }, {
      cardId: ctx.cardId,
      defaultOwnerPersonId: ctx.amitId,
    });
    const after = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(after.claims[0]?.id).toBe(claimId);
    expect(after.claims[0]?.personId).toBe(ctx.rahulId);
    expect(after.eventShares.map((share) => share.amountPaise).sort()).toEqual(shareAmounts);
    expect(after.creditCards[0]?.defaultOwnerPersonId).toBe(ctx.amitId);
  });

  it("L — invalid shares reject with no partial writes", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    const before = tableCounts(ctx.handles, ctx.workspaceId);
    await expect(
      recordSplit(ctx.handles, { workspaceId: ctx.workspaceId }, {
        occurredOn: "2026-08-16",
        capturedAt,
        amountPaise: 300_000,
        source: { type: "account", accountId: ctx.hdfcId },
        userSharePaise: 120_000,
        personShares: [{ personId: ctx.rahulId, amountPaise: 100_000 }],
        allocations: [{ categoryId: ctx.groceryId, amountPaise: 120_000 }],
        commit: true,
      }),
    ).rejects.toThrow(DomainError);
    expect(tableCounts(ctx.handles, ctx.workspaceId)).toEqual(before);
    expect(await balance(ctx.handles, ctx.workspaceId, ctx.hdfcId)).toBe(5_000_000);
  });

  it("keeps archived people readable and does not merge matching claims", async () => {
    const ctx = await setup();
    contexts.push(ctx.handles);
    await lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-16",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 100_000,
      commit: true,
    });
    await lendMoney(ctx.handles, { workspaceId: ctx.workspaceId }, {
      occurredOn: "2026-08-17",
      capturedAt,
      accountId: ctx.hdfcId,
      personId: ctx.rahulId,
      amountPaise: 100_000,
      commit: true,
    });
    await updatePerson(ctx.handles, { workspaceId: ctx.workspaceId }, {
      personId: ctx.rahulId,
      name: "Rahul K",
      status: "archived",
    });
    const snapshot = await loadSnapshot(ctx.handles, ctx.workspaceId);
    expect(snapshot.people.find((person) => person.id === ctx.rahulId)?.name).toBe("Rahul K");
    expect(snapshot.claims).toHaveLength(2);
    const detail = await personDetail(ctx.handles, ctx.workspaceId, ctx.rahulId);
    expect(detail.status).toBe("archived");
    expect(detail.history).toHaveLength(2);
    expect((await listActivity(ctx.handles, ctx.workspaceId)).every((event) => event.counterpartyName === "Rahul K")).toBe(
      true,
    );
  });
});
