import { and, eq, gte, lte, sql } from "drizzle-orm";
import { paise, sumPaise } from "../domain/money/paise.js";
import {
  kolkataAddMonths,
  kolkataMonthEnd,
  kolkataMonthStart,
  todayKolkata,
} from "../domain/calendar/kolkata.js";
import { formatCardLabel } from "../domain/cycle/lifecycle.js";
import { DomainError, type ClaimDirection, type LedgerBillingCycle } from "../domain/ledger/types.js";
import { personPosition } from "../domain/people/position.js";
import { suggestAllocations, suggestableClaimsFor } from "../domain/commands/suggestAllocations.js";
import { claimLabel } from "../domain/commands/settle.js";
import { loadSnapshot } from "./loadSnapshot.js";
import { loadCardRule } from "./config.js";
import { categories, financialEvents, postings } from "./schema.js";
import type { SqliteHandles } from "./client.js";

export function listAccounts(handles: SqliteHandles, workspaceId: string) {
  const snapshot = loadSnapshot(handles, workspaceId);
  return snapshot.accounts
    .filter((account) => account.status === "active")
    .map((account) => ({
      id: account.id,
      displayName: account.displayName,
      kind: account.kind,
      mask: account.mask,
      isPrimarySalary: account.isPrimarySalary,
      balancePaise: account.balancePaise,
      hasOpening: snapshot.openings.some(
        (opening) => opening.kind === "account" && opening.subjectId === account.id,
      ),
    }));
}

export function listCategories(handles: SqliteHandles, workspaceId: string, includeArchived = false) {
  return handles.db
    .select()
    .from(categories)
    .where(eq(categories.workspaceId, workspaceId))
    .all()
    .filter((row) => includeArchived || !row.archivedAt)
    .map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      archivedAt: row.archivedAt,
    }));
}

export type ActivityFilter = {
  categoryId?: string;
  month?: string;
};

export function listActivity(
  handles: SqliteHandles,
  workspaceId: string,
  filter: ActivityFilter = {},
) {
  const snapshot = loadSnapshot(handles, workspaceId);
  const accountName = new Map(snapshot.accounts.map((account) => [account.id, account.displayName]));
  const categoryName = new Map(snapshot.categories.map((category) => [category.id, category.name]));

  return snapshot.events
    .filter(
      (event) =>
        event.meaning === "income" ||
        event.meaning === "spend_account" ||
        event.meaning === "transfer" ||
        event.meaning === "spend_card" ||
        event.meaning === "pay_obligation" ||
        event.meaning === "split" ||
        event.meaning === "lend" ||
        event.meaning === "borrow" ||
        event.meaning === "settlement_in" ||
        event.meaning === "settlement_out",
    )
    .filter((event) => {
      if (!filter.month) return true;
      return event.occurredOn.startsWith(filter.month);
    })
    .filter((event) => {
      if (!filter.categoryId) return true;
      return snapshot.postings.some(
        (posting) =>
          posting.eventId === event.id &&
          posting.pnl === "expense" &&
          posting.categoryId === filter.categoryId,
      );
    })
    .sort((a, b) => {
      if (a.occurredOn === b.occurredOn) return a.capturedAt < b.capturedAt ? 1 : -1;
      return a.occurredOn < b.occurredOn ? 1 : -1;
    })
    .map((event) => {
      const expensePostings = snapshot.postings.filter(
        (posting) => posting.eventId === event.id && posting.pnl === "expense",
      );
      const incomePostings = snapshot.postings.filter(
        (posting) =>
          posting.eventId === event.id &&
          (posting.pnl === "income_salary" || posting.pnl === "income_other"),
      );
      const accountPostings = snapshot.postings.filter(
        (posting) => posting.eventId === event.id && posting.accountId,
      );
      // Transfer convention: event.accountId is source; destination is the
      // positive account posting on the same event.
      const source = accountPostings.find((posting) => posting.amountPaise < 0);
      const destination = accountPostings.find((posting) => posting.amountPaise > 0);
      const card = event.creditCardId
        ? snapshot.creditCards.find((item) => item.id === event.creditCardId)
        : undefined;
      const cardLabel = card ? formatCardLabel(card.displayName, card.mask) : null;
      const shares = snapshot.eventShares
        .filter((share) => share.eventId === event.id)
        .map((share) => ({
          personId: share.personId,
          personName: share.isUser
            ? "You"
            : (snapshot.people.find((person) => person.id === share.personId)?.name ?? "Someone"),
          amountPaise: share.amountPaise,
          isUser: share.isUser,
        }));
      const claim = snapshot.claims.find((item) => item.originatingEventId === event.id);
      const settlementRows = snapshot.settlementAllocations.filter((item) => item.eventId === event.id);
      const settlementPersonId = settlementRows
        .map((row) => snapshot.claims.find((item) => item.id === row.claimId)?.personId)
        .find((id) => id);
      const counterparty = claim
        ? snapshot.people.find((person) => person.id === claim.personId)
        : settlementPersonId
          ? snapshot.people.find((person) => person.id === settlementPersonId)
          : undefined;
      const userShare = shares.find((share) => share.isUser);
      const otherOwned =
        event.meaning === "spend_card" &&
        userShare !== undefined &&
        userShare.amountPaise === 0 &&
        shares.some((share) => !share.isUser);
      return {
        id: event.id,
        meaning: event.meaning,
        occurredOn: event.occurredOn,
        amountPaise: event.amountPaise,
        accountName: event.accountId ? (accountName.get(event.accountId) ?? null) : null,
        fromAccountName: source?.accountId ? (accountName.get(source.accountId) ?? null) : null,
        toAccountName: destination?.accountId
          ? (accountName.get(destination.accountId) ?? null)
          : null,
        cardLabel,
        merchant: event.merchant,
        categories: expensePostings.map((posting) => ({
          id: posting.categoryId,
          name: posting.categoryId ? (categoryName.get(posting.categoryId) ?? "Expense") : "Expense",
          amountPaise: posting.amountPaise,
        })),
        incomeKind:
          incomePostings[0]?.pnl === "income_salary"
            ? "salary"
            : incomePostings[0]?.pnl === "income_other"
              ? "other"
              : null,
        shares,
        counterpartyName: counterparty?.name ?? shares.find((share) => !share.isUser)?.personName ?? null,
        otherOwned,
        personalAmountPaise: expensePostings.reduce((sum, posting) => sum + posting.amountPaise, 0),
        allocations: settlementRows.map((row) => {
          const allocatedClaim = snapshot.claims.find((item) => item.id === row.claimId);
          return {
            claimId: row.claimId,
            amountPaise: row.amountPaise,
            label: allocatedClaim ? claimLabel(allocatedClaim, snapshot) : "Claim",
          };
        }),
      };
    });
}

function expenseTotalForMonth(
  handles: SqliteHandles,
  workspaceId: string,
  start: string,
  end: string,
): number {
  const row = handles.db
    .select({
      total: sql<number>`coalesce(sum(${postings.amountPaise}), 0)`,
    })
    .from(postings)
    .innerJoin(financialEvents, eq(postings.eventId, financialEvents.id))
    .where(
      and(
        eq(postings.workspaceId, workspaceId),
        eq(postings.pnl, "expense"),
        gte(financialEvents.occurredOn, start),
        lte(financialEvents.occurredOn, end),
      ),
    )
    .get();
  return row?.total ?? 0;
}

export function currentMonthSpend(handles: SqliteHandles, workspaceId: string, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  return {
    asOf,
    month: asOf.slice(0, 7),
    spentPaise: paise(expenseTotalForMonth(handles, workspaceId, start, end)),
  };
}

export function monthReview(handles: SqliteHandles, workspaceId: string, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  const previousStart = kolkataMonthStart(kolkataAddMonths(start, -1));
  const previousEnd = kolkataMonthEnd(previousStart);
  const snapshot = loadSnapshot(handles, workspaceId);
  const categoryName = new Map(snapshot.categories.map((category) => [category.id, category.name]));

  const grouped = new Map<string, number>();
  for (const posting of snapshot.postings) {
    if (posting.pnl !== "expense" || !posting.categoryId) continue;
    const event = snapshot.events.find((item) => item.id === posting.eventId);
    if (!event) continue;
    if (event.occurredOn < start || event.occurredOn > end) continue;
    grouped.set(posting.categoryId, (grouped.get(posting.categoryId) ?? 0) + posting.amountPaise);
  }

  const spentPaise = expenseTotalForMonth(handles, workspaceId, start, end);
  const previousSpentPaise = expenseTotalForMonth(
    handles,
    workspaceId,
    previousStart,
    previousEnd,
  );

  return {
    asOf,
    month: start.slice(0, 7),
    spentPaise: paise(spentPaise),
    previousMonth: previousStart.slice(0, 7),
    previousSpentPaise: paise(previousSpentPaise),
    differencePaise: paise(spentPaise - previousSpentPaise),
    categories: [...grouped.entries()]
      .map(([categoryId, amount]) => ({
        categoryId,
        name: categoryName.get(categoryId) ?? "Expense",
        spentPaise: paise(amount),
      }))
      .sort((left, right) => right.spentPaise - left.spentPaise),
  };
}

function cycleView(cycle: LedgerBillingCycle) {
  return {
    id: cycle.id,
    creditCardId: cycle.creditCardId,
    purchaseWindowStart: cycle.purchaseWindowStart,
    purchaseWindowEnd: cycle.purchaseWindowEnd,
    expectedStatementOn: cycle.expectedStatementOn,
    actualStatementOn: cycle.actualStatementOn,
    expectedDueOn: cycle.expectedDueOn,
    actualDueOn: cycle.actualDueOn,
    dueOn: cycle.actualDueOn ?? cycle.expectedDueOn,
    expectedAmountPaise: cycle.expectedAmountPaise,
    actualStatementAmountPaise: cycle.actualStatementAmountPaise,
    amountPaidPaise: cycle.amountPaidPaise,
    ledgerRemainingPaise: cycle.ledgerRemainingPaise,
    statementRemainingPaise: cycle.statementRemainingPaise,
    remainingPaise: cycle.remainingPaise,
    mismatch: cycle.mismatch,
    status: cycle.status,
    lifecycle: cycle.lifecycle,
    ruleSnapshot: cycle.ruleSnapshot,
  };
}

export function listCards(handles: SqliteHandles, workspaceId: string, asOf = todayKolkata()) {
  const snapshot = loadSnapshot(handles, workspaceId, asOf);
  return snapshot.creditCards
    .filter((card) => card.status === "active")
    .map((card) => {
      const cycles = snapshot.billingCycles.filter((cycle) => cycle.creditCardId === card.id);
      const outstandingPaise = sumPaise(cycles.map((cycle) => cycle.ledgerRemainingPaise));
      const current =
        cycles.find(
          (cycle) => cycle.purchaseWindowStart <= asOf && asOf <= cycle.purchaseWindowEnd,
        ) ?? null;
      const nextDue = cycles
        .filter((cycle) => cycle.ledgerRemainingPaise > 0 || cycle.statementRemainingPaise > 0)
        .map((cycle) => cycle.actualDueOn ?? cycle.expectedDueOn)
        .sort()[0];
      const rule = loadCardRule(handles, workspaceId, card.id, asOf);
      return {
        id: card.id,
        displayName: card.displayName,
        issuer: card.issuer,
        mask: card.mask,
        label: formatCardLabel(card.displayName, card.mask),
        creditLimitPaise: card.creditLimitPaise,
        defaultPaymentAccountId: card.defaultPaymentAccountId,
        defaultOwnerPersonId: card.defaultOwnerPersonId,
        defaultOwnerName: card.defaultOwnerPersonId
          ? (snapshot.people.find((person) => person.id === card.defaultOwnerPersonId)?.name ?? null)
          : null,
        status: card.status,
        outstandingPaise,
        currentCycle: current ? cycleView(current) : null,
        nextDueOn: nextDue ?? current?.actualDueOn ?? current?.expectedDueOn ?? null,
        statementDay: rule.statementDay,
        dueDaysAfterStatement: rule.dueDaysAfterStatement,
      };
    });
}

export function cardDetail(
  handles: SqliteHandles,
  workspaceId: string,
  cardId: string,
  asOf = todayKolkata(),
) {
  const snapshot = loadSnapshot(handles, workspaceId, asOf);
  const card = snapshot.creditCards.find((item) => item.id === cardId);
  if (!card) {
    throw new DomainError("card_not_found", "Credit card not found");
  }
  const cycles = snapshot.billingCycles
    .filter((cycle) => cycle.creditCardId === card.id)
    .sort((left, right) => right.expectedStatementOn.localeCompare(left.expectedStatementOn));
  const outstandingPaise = sumPaise(cycles.map((cycle) => cycle.ledgerRemainingPaise));
  const rule = loadCardRule(handles, workspaceId, card.id, asOf);
  const activity = listActivity(handles, workspaceId).filter((event) =>
    snapshot.events.some(
      (item) => item.id === event.id && item.creditCardId === card.id,
    ),
  );
  return {
    id: card.id,
    displayName: card.displayName,
    issuer: card.issuer,
    mask: card.mask,
    label: formatCardLabel(card.displayName, card.mask),
    creditLimitPaise: card.creditLimitPaise,
    defaultPaymentAccountId: card.defaultPaymentAccountId,
    defaultOwnerPersonId: card.defaultOwnerPersonId,
    defaultOwnerName: card.defaultOwnerPersonId
      ? (snapshot.people.find((person) => person.id === card.defaultOwnerPersonId)?.name ?? null)
      : null,
    status: card.status,
    outstandingPaise,
    statementDay: rule.statementDay,
    dueDaysAfterStatement: rule.dueDaysAfterStatement,
    cycles: cycles.map(cycleView),
    transactions: activity,
  };
}

export function cycleDetail(
  handles: SqliteHandles,
  workspaceId: string,
  cycleId: string,
  asOf = todayKolkata(),
) {
  const snapshot = loadSnapshot(handles, workspaceId, asOf);
  const cycle = snapshot.billingCycles.find((item) => item.id === cycleId);
  if (!cycle) {
    throw new DomainError("cycle_not_found", "Billing cycle not found");
  }
  const card = snapshot.creditCards.find((item) => item.id === cycle.creditCardId);
  if (!card) {
    throw new DomainError("card_not_found", "Credit card not found");
  }
  const categoryName = new Map(snapshot.categories.map((category) => [category.id, category.name]));
  const spends = snapshot.events
    .filter(
      (event) =>
        event.billingCycleId === cycle.id &&
        (event.meaning === "spend_card" || event.meaning === "split"),
    )
    .sort((left, right) => left.occurredOn.localeCompare(right.occurredOn))
    .map((event) => {
      const expensePostings = snapshot.postings.filter(
        (posting) => posting.eventId === event.id && posting.pnl === "expense",
      );
      return {
        id: event.id,
        occurredOn: event.occurredOn,
        amountPaise: event.amountPaise,
        merchant: event.merchant,
        categories: expensePostings.map((posting) => ({
          id: posting.categoryId,
          name: posting.categoryId ? (categoryName.get(posting.categoryId) ?? "Expense") : "Expense",
          amountPaise: posting.amountPaise,
        })),
      };
    });
  const payments = snapshot.events
    .filter((event) => event.billingCycleId === cycle.id && event.meaning === "pay_obligation")
    .sort((left, right) => left.occurredOn.localeCompare(right.occurredOn))
    .map((event) => ({
      id: event.id,
      occurredOn: event.occurredOn,
      amountPaise: event.amountPaise,
      accountName:
        snapshot.accounts.find((account) => account.id === event.accountId)?.displayName ?? null,
    }));
  return {
    ...cycleView(cycle),
    card: {
      id: card.id,
      label: formatCardLabel(card.displayName, card.mask),
      displayName: card.displayName,
      mask: card.mask,
    },
    spends,
    payments,
  };
}

export function comingCardPayments(
  handles: SqliteHandles,
  workspaceId: string,
  asOf = todayKolkata(),
) {
  const snapshot = loadSnapshot(handles, workspaceId, asOf);
  return snapshot.billingCycles
    .filter(
      (cycle) => cycle.ledgerRemainingPaise > 0 || cycle.statementRemainingPaise > 0 || cycle.mismatch,
    )
    .map((cycle) => {
      const card = snapshot.creditCards.find((item) => item.id === cycle.creditCardId);
      return {
        cycleId: cycle.id,
        cardId: cycle.creditCardId,
        cardLabel: card ? formatCardLabel(card.displayName, card.mask) : "Card",
        dueOn: cycle.actualDueOn ?? cycle.expectedDueOn,
        remainingPaise: cycle.remainingPaise,
        ledgerRemainingPaise: cycle.ledgerRemainingPaise,
        statementRemainingPaise: cycle.statementRemainingPaise,
        expectedAmountPaise: cycle.expectedAmountPaise,
        actualStatementAmountPaise: cycle.actualStatementAmountPaise,
        mismatch: cycle.mismatch,
        lifecycle: cycle.lifecycle,
      };
    })
    .sort((left, right) => left.dueOn.localeCompare(right.dueOn));
}

export function listPeople(handles: SqliteHandles, workspaceId: string) {
  const snapshot = loadSnapshot(handles, workspaceId);
  return snapshot.people
    .map((person) => {
      const position = personPosition(snapshot.claims, person.id);
      const group =
        position.netPaise > 0 ? "they_owe_you" : position.netPaise < 0 ? "you_owe" : "settled";
      return {
        id: person.id,
        name: person.name,
        notes: person.notes,
        status: person.status,
        theyOwePaise: position.theyOwePaise,
        youOwePaise: position.youOwePaise,
        netPaise: position.netPaise,
        openItemCount: position.openItemCount,
        group,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function personDetail(handles: SqliteHandles, workspaceId: string, personId: string) {
  const snapshot = loadSnapshot(handles, workspaceId);
  const person = snapshot.people.find((item) => item.id === personId);
  if (!person) {
    throw new DomainError("person_not_found", "Person not found");
  }
  const position = personPosition(snapshot.claims, person.id);
  const opening = snapshot.openings.find(
    (item) => item.kind === "person" && item.subjectId === person.id,
  );
  const claimViews = snapshot.claims
    .filter((claim) => claim.personId === person.id)
    .map((claim) => {
      const event = claim.originatingEventId
        ? snapshot.events.find((item) => item.id === claim.originatingEventId)
        : undefined;
      const cycle = claim.billingCycleId
        ? snapshot.billingCycles.find((item) => item.id === claim.billingCycleId)
        : undefined;
      const card = cycle
        ? snapshot.creditCards.find((item) => item.id === cycle.creditCardId)
        : undefined;
      const settledAmountPaise = paise(claim.originalAmountPaise - claim.openAmountPaise);
      return {
        id: claim.id,
        kind: claim.kind,
        direction: claim.direction,
        status: claim.status,
        originalAmountPaise: claim.originalAmountPaise,
        settledAmountPaise,
        openAmountPaise: claim.openAmountPaise,
        originatingEventId: claim.originatingEventId,
        originatingMeaning: event?.meaning ?? null,
        originatingMerchant: event?.merchant ?? null,
        occurredOn: event?.occurredOn ?? opening?.effectiveOn ?? null,
        billingCycleId: claim.billingCycleId,
        cycleStatementOn: cycle?.expectedStatementOn ?? null,
        cardLabel: card ? formatCardLabel(card.displayName, card.mask) : null,
        note: claim.note,
      };
    });
  const openClaims = claimViews.filter((claim) => claim.status === "open");
  const eventIds = new Set<string>();
  for (const claim of snapshot.claims.filter((item) => item.personId === person.id)) {
    if (claim.originatingEventId) eventIds.add(claim.originatingEventId);
  }
  for (const share of snapshot.eventShares.filter((item) => item.personId === person.id)) {
    eventIds.add(share.eventId);
  }
  for (const allocation of snapshot.settlementAllocations) {
    const claim = snapshot.claims.find((item) => item.id === allocation.claimId);
    if (claim?.personId === person.id) eventIds.add(allocation.eventId);
  }
  const history = listActivity(handles, workspaceId).filter((event) => eventIds.has(event.id));
  return {
    id: person.id,
    name: person.name,
    notes: person.notes,
    status: person.status,
    theyOwePaise: position.theyOwePaise,
    youOwePaise: position.youOwePaise,
    netPaise: position.netPaise,
    openItemCount: position.openItemCount,
    hasOpening: Boolean(opening),
    openingEffectiveOn: opening?.effectiveOn ?? null,
    openClaims,
    claims: claimViews,
    history,
  };
}

export function suggestPersonAllocations(
  handles: SqliteHandles,
  workspaceId: string,
  personId: string,
  amountPaise: number,
  direction: ClaimDirection,
) {
  const snapshot = loadSnapshot(handles, workspaceId);
  const person = snapshot.people.find((item) => item.id === personId);
  if (!person) {
    throw new DomainError("person_not_found", "Person not found");
  }
  const claims = suggestableClaimsFor(snapshot, personId, direction);
  return {
    allocations: suggestAllocations(claims, paise(amountPaise)),
    claims: snapshot.claims
      .filter((claim) => claim.personId === personId && claim.direction === direction && claim.status === "open")
      .map((claim) => ({
        id: claim.id,
        kind: claim.kind,
        openAmountPaise: claim.openAmountPaise,
        label: claimLabel(claim, snapshot),
      })),
  };
}
