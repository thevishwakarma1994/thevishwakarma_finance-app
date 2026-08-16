import { eq } from "drizzle-orm";
import { paise } from "../domain/money/paise.js";
import { isoDate } from "../domain/calendar/isoDate.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import { parseCardCycleRule } from "../domain/cycle/assign.js";
import { enrichBillingCycles } from "../domain/cycle/lifecycle.js";
import type {
  BillingCycleRecord,
  ClaimDirection,
  ClaimKind,
  ClaimStatus,
  CreditCardRecord,
  LedgerAccount,
  LedgerClaim,
  LedgerSnapshot,
  OpeningPosition,
  PersonStatus,
} from "../domain/ledger/types.js";
import { isAccountOpeningPayload } from "../domain/ledger/types.js";
import {
  accounts,
  billingCycles,
  categories,
  claims,
  creditCards,
  eventShares,
  financialEvents,
  openingPositions,
  people,
  postings,
} from "./schema.js";
import type { SqliteHandles } from "./client.js";

export function loadSnapshot(
  handles: SqliteHandles,
  workspaceId: string,
  asOf = todayKolkata(),
): LedgerSnapshot {
  const accountRows = handles.db
    .select()
    .from(accounts)
    .where(eq(accounts.workspaceId, workspaceId))
    .all();
  const cardRows = handles.db
    .select()
    .from(creditCards)
    .where(eq(creditCards.workspaceId, workspaceId))
    .all();
  const cycleRows = handles.db
    .select()
    .from(billingCycles)
    .where(eq(billingCycles.workspaceId, workspaceId))
    .all();
  const categoryRows = handles.db
    .select()
    .from(categories)
    .where(eq(categories.workspaceId, workspaceId))
    .all();
  const eventRows = handles.db
    .select()
    .from(financialEvents)
    .where(eq(financialEvents.workspaceId, workspaceId))
    .all();
  const postingRows = handles.db
    .select()
    .from(postings)
    .where(eq(postings.workspaceId, workspaceId))
    .all();
  const openingRows = handles.db
    .select()
    .from(openingPositions)
    .where(eq(openingPositions.workspaceId, workspaceId))
    .all();
  const peopleRows = handles.db
    .select()
    .from(people)
    .where(eq(people.workspaceId, workspaceId))
    .all();
  const claimRows = handles.db
    .select()
    .from(claims)
    .where(eq(claims.workspaceId, workspaceId))
    .all();
  const shareRows = handles.db
    .select()
    .from(eventShares)
    .where(eq(eventShares.workspaceId, workspaceId))
    .all();

  const openings: OpeningPosition[] = openingRows.map((row) => {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (row.kind === "person") {
      return {
        id: row.id,
        effectiveOn: isoDate(row.effectiveOn),
        kind: "person",
        subjectId: row.subjectId,
        payload: {
          direction: payload.direction as ClaimDirection,
          amountPaise: paise(Number(payload.amountPaise)),
          note: typeof payload.note === "string" ? payload.note : null,
        },
      };
    }
    return {
      id: row.id,
      effectiveOn: isoDate(row.effectiveOn),
      kind: row.kind as OpeningPosition["kind"],
      subjectId: row.subjectId,
      payload: { balancePaise: paise(Number(payload.balancePaise)) },
    };
  });

  const ledgerAccounts: LedgerAccount[] = accountRows.map((row) => {
    const opening = openings.find(
      (item) => item.kind === "account" && item.subjectId === row.id,
    );
    const openingBalancePaise =
      opening && isAccountOpeningPayload(opening.payload) ? opening.payload.balancePaise : paise(0);
    const postedPaise = paise(
      postingRows
        .filter((posting) => posting.accountId === row.id)
        .reduce((sum, posting) => sum + posting.amountPaise, 0),
    );
    return {
      id: row.id,
      kind: row.kind as LedgerAccount["kind"],
      displayName: row.displayName,
      mask: row.mask,
      isPrimarySalary: row.isPrimarySalary === 1,
      status: row.status as LedgerAccount["status"],
      openingBalancePaise,
      postedPaise,
      balancePaise: paise(openingBalancePaise + postedPaise),
    };
  });

  const creditCardRecords: CreditCardRecord[] = cardRows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    issuer: row.issuer,
    mask: row.mask,
    creditLimitPaise: row.creditLimitPaise === null ? null : paise(row.creditLimitPaise),
    defaultPaymentAccountId: row.defaultPaymentAccountId,
    defaultOwnerPersonId: row.defaultOwnerPersonId,
    status: row.status as CreditCardRecord["status"],
  }));

  const events = eventRows.map((row) => ({
    id: row.id,
    meaning: row.meaning as LedgerSnapshot["events"][number]["meaning"],
    occurredOn: isoDate(row.occurredOn),
    capturedAt: row.capturedAt,
    amountPaise: paise(row.amountPaise),
    accountId: row.accountId,
    creditCardId: row.creditCardId,
    loanId: null,
    billingCycleId: row.billingCycleId,
    fundingCycleId: null,
    categoryId: row.categoryId,
    channel: row.channel,
    merchant: row.merchant,
    notes: row.notes,
    reversalOfEventId: row.reversalOfEventId,
  }));

  const ledgerPostings = postingRows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    amountPaise: paise(row.amountPaise),
    accountId: row.accountId,
    creditCardId: row.creditCardId,
    loanId: null,
    pnl: row.pnl as LedgerSnapshot["postings"][number]["pnl"],
    categoryId: row.categoryId,
    claimId: row.claimId,
    billingCycleId: row.billingCycleId,
  }));

  const cycleRecords: BillingCycleRecord[] = cycleRows.map((row) => ({
    id: row.id,
    creditCardId: row.creditCardId,
    purchaseWindowStart: isoDate(row.purchaseWindowStart),
    purchaseWindowEnd: isoDate(row.purchaseWindowEnd),
    expectedStatementOn: isoDate(row.expectedStatementOn),
    actualStatementOn: row.actualStatementOn ? isoDate(row.actualStatementOn) : null,
    expectedDueOn: isoDate(row.expectedDueOn),
    actualDueOn: row.actualDueOn ? isoDate(row.actualDueOn) : null,
    actualStatementAmountPaise:
      row.actualStatementAmountPaise === null ? null : paise(row.actualStatementAmountPaise),
    ruleSnapshot: parseCardCycleRule(JSON.parse(row.ruleSnapshot)),
  }));

  const ledgerClaims: LedgerClaim[] = claimRows.map((row) => ({
    id: row.id,
    personId: row.personId,
    direction: row.direction as ClaimDirection,
    kind: row.kind as ClaimKind,
    originalAmountPaise: paise(row.originalAmountPaise),
    originatingEventId: row.originatingEventId,
    openingPositionId: row.openingPositionId,
    billingCycleId: row.billingCycleId,
    note: row.note,
    status: row.status as ClaimStatus,
    openAmountPaise: paise(row.originalAmountPaise),
  }));

  return {
    accounts: ledgerAccounts,
    categories: categoryRows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      archivedAt: row.archivedAt,
    })),
    creditCards: creditCardRecords,
    people: peopleRows.map((row) => ({
      id: row.id,
      name: row.name,
      notes: row.notes,
      status: row.status as PersonStatus,
    })),
    billingCycles: enrichBillingCycles(cycleRecords, events, ledgerPostings, asOf),
    claims: ledgerClaims,
    eventShares: shareRows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      personId: row.personId,
      amountPaise: paise(row.amountPaise),
      isUser: row.isUser === 1,
    })),
    events,
    postings: ledgerPostings,
    openings,
  };
}

export function getAccountBalance(
  handles: SqliteHandles,
  workspaceId: string,
  accountId: string,
): number {
  const snapshot = loadSnapshot(handles, workspaceId);
  const account = snapshot.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("Account not found");
  }
  return account.balancePaise;
}
