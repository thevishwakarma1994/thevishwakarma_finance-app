import { and, eq, gte, lte, sql } from "drizzle-orm";
import { paise, sumPaise } from "../domain/money/paise.js";
import {
  kolkataAddMonths,
  kolkataMonthEnd,
  kolkataMonthStart,
  todayKolkata,
} from "../domain/calendar/kolkata.js";
import { formatCardLabel } from "../domain/cycle/lifecycle.js";
import { DomainError, type ClaimDirection, type LedgerBillingCycle, type LedgerSnapshot } from "../domain/ledger/types.js";
import { personPosition } from "../domain/people/position.js";
import { suggestAllocations, suggestableClaimsFor } from "../domain/commands/suggestAllocations.js";
import { claimLabel } from "../domain/commands/settle.js";
import { cardHasLifecycleActivity, deriveOpeningCardPosition } from "../domain/commands/openingCard.js";
import { accountAvailability } from "../domain/engine/liquidity.js";
import { evaluateSafeToSpend } from "../domain/engine/evaluateSafeToSpend.js";
import { policyAsOf, typicalOnForCycle } from "../domain/funding/cycles.js";
import { comingUpItems, filterComingUp, type ComingUpFilter } from "../domain/engine/comingUp.js";
import { cycleCardLabel } from "../domain/reservations/create.js";
import { reservedTowardCycle } from "../domain/reservations/derive.js";
import { loadSnapshot } from "./loadSnapshot.js";
import { loadCardRule } from "./config.js";
import type { DbHandles } from "./handles.js";
import { anyDb, queryAll, queryGet, tables } from "./exec.js"; 
import { fromStoredPaise } from "./storedPaise.js"; 
import { addDbQueries, timedPerf, timedPerfSync } from "../perf/timing.js";

export async function listAccounts(handles: DbHandles, workspaceId: string) {
  return listAccountsFromSnapshot(await loadSnapshot(handles, workspaceId));
}

/** Accounts list from an already-loaded snapshot — no DB access. */
export function listAccountsFromSnapshot(snapshot: LedgerSnapshot) {
  return snapshot.accounts
    .filter((account) => account.status === "active")
    .map((account) => {
      const availability = accountAvailability(snapshot, account.id);
      const reservedDetails = snapshot.reservations
        .filter((reservation) => reservation.sourceAccountId === account.id && reservation.remainingPaise > 0)
        .map((reservation) => {
          const cycle =
            reservation.obligationRef.type === "billing_cycle"
              ? snapshot.billingCycles.find((item) => item.id === reservation.obligationRef.id)
              : undefined;
          const claim = reservation.originatingClaimId
            ? snapshot.claims.find((item) => item.id === reservation.originatingClaimId)
            : undefined;
          const person = claim
            ? snapshot.people.find((item) => item.id === claim.personId)
            : undefined;
          return {
            reservationId: reservation.id,
            amountPaise: reservation.remainingPaise,
            cardLabel:
              reservation.obligationRef.type === "billing_cycle"
                ? cycleCardLabel(snapshot, reservation.obligationRef.id)
                : "Obligation",
            dueOn: cycle ? (cycle.actualDueOn ?? cycle.expectedDueOn) : null,
            personName: person?.name ?? null,
            claimId: claim?.id ?? null,
          };
        });
      return {
        id: account.id,
        displayName: account.displayName,
        kind: account.kind,
        mask: account.mask,
        isPrimarySalary: account.isPrimarySalary,
        balancePaise: availability.balancePaise,
        reservedPaise: availability.reservedActivePaise,
        pendingSurplusPaise: availability.pendingSurplusHeldPaise,
        availablePaise: availability.availablePaise,
        reservedDetails,
        hasOpening: snapshot.openings.some(
          (opening) => opening.kind === "account" && opening.subjectId === account.id,
        ),
      };
    });
}

export async function listCategories(handles: DbHandles, workspaceId: string, includeArchived = false) {
  const t = tables(handles);
  const all = await queryAll<{
    id: string;
    name: string;
    parentId: string | null;
    archivedAt: string | null;
  }>(handles, anyDb(handles).select().from(t.categories).where(eq(t.categories.workspaceId, workspaceId)));
  return all
    .filter((row) => includeArchived || !row.archivedAt)
    .map((row) => ({
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      archivedAt: row.archivedAt,
    }));
}

/** Categories from an already-loaded snapshot — no DB access. */
export function listCategoriesFromSnapshot(snapshot: LedgerSnapshot, includeArchived = false) {
  return snapshot.categories
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

export async function listActivity(
  handles: DbHandles,
  workspaceId: string,
  filter: ActivityFilter = {},
) {
  const snapshot = await loadSnapshot(handles, workspaceId);
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
      const reservedForEvent = settlementRows
        .filter((row) => row.createsReservation)
        .reduce((sum, row) => {
          const reservation = row.reservationId
            ? snapshot.reservations.find((item) => item.id === row.reservationId)
            : undefined;
          return sum + (reservation?.amountOriginalPaise ?? row.amountPaise);
        }, 0);
      const surplusForEvent = snapshot.surplusCases
        .filter((item) => item.eventId === event.id && item.status === "pending")
        .reduce((sum, item) => sum + item.amountPaise, 0);
      const availableForEvent =
        event.meaning === "settlement_in"
          ? Math.max(0, event.amountPaise - reservedForEvent - surplusForEvent)
          : 0;
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
          const reservation = row.reservationId
            ? snapshot.reservations.find((item) => item.id === row.reservationId)
            : undefined;
          return {
            claimId: row.claimId,
            amountPaise: row.amountPaise,
            label: allocatedClaim ? claimLabel(allocatedClaim, snapshot) : "Claim",
            createsReservation: row.createsReservation,
            reservedPaise: reservation?.amountOriginalPaise ?? 0,
            cardLabel:
              reservation?.obligationRef.type === "billing_cycle"
                ? cycleCardLabel(snapshot, reservation.obligationRef.id)
                : null,
          };
        }),
        surplusPaise: snapshot.surplusCases
          .filter((item) => item.eventId === event.id && item.status === "pending")
          .reduce((sum, item) => sum + item.amountPaise, 0),
        consequences: [
          ...settlementRows
            .filter((row) => row.createsReservation)
            .map((row) => {
              const reservation = row.reservationId
                ? snapshot.reservations.find((item) => item.id === row.reservationId)
                : undefined;
              const cardLabel =
                reservation?.obligationRef.type === "billing_cycle"
                  ? cycleCardLabel(snapshot, reservation.obligationRef.id)
                  : "card";
              return {
                kind: "reserved" as const,
                amountPaise: reservation?.amountOriginalPaise ?? row.amountPaise,
                label: `reserved for ${cardLabel}`,
              };
            }),
          ...snapshot.surplusCases
            .filter((item) => item.eventId === event.id && item.status === "pending")
            .map((item) => ({
              kind: "needs_review" as const,
              amountPaise: item.amountPaise,
              label: "needs review",
            })),
          ...(availableForEvent > 0
            ? [
                {
                  kind: "available" as const,
                  amountPaise: availableForEvent,
                  label: "available",
                },
              ]
            : []),
        ],
      };
    });
}

async function expenseTotalForMonth(
  handles: DbHandles,
  workspaceId: string,
  start: string,
  end: string,
): Promise<number> {
  const t = tables(handles);
  const row = await queryGet<{ total: number | string }>(
    handles,
    anyDb(handles)
      .select({
        total: sql<number>`coalesce(sum(${t.postings.amountPaise}), 0)`,
      })
      .from(t.postings)
      .innerJoin(t.financialEvents, eq(t.postings.eventId, t.financialEvents.id))
      .where(
        and(
          eq(t.postings.workspaceId, workspaceId),
          eq(t.postings.pnl, "expense"),
          gte(t.financialEvents.occurredOn, start),
          lte(t.financialEvents.occurredOn, end),
        ),
      ),
  );
  return fromStoredPaise(row?.total ?? 0);
}

export async function currentMonthSpend(handles: DbHandles, workspaceId: string, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  return {
    asOf,
    month: asOf.slice(0, 7),
    spentPaise: paise(await expenseTotalForMonth(handles, workspaceId, start, end)),
  };
}

/** Month spend from an already-loaded snapshot — no DB access. */
export function currentMonthSpendFromSnapshot(snapshot: LedgerSnapshot, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  let spent = 0;
  for (const posting of snapshot.postings) {
    if (posting.pnl !== "expense") continue;
    const event = snapshot.events.find((item) => item.id === posting.eventId);
    if (!event) continue;
    if (event.occurredOn < start || event.occurredOn > end) continue;
    spent += posting.amountPaise;
  }
  return {
    asOf,
    month: asOf.slice(0, 7),
    spentPaise: paise(spent),
  };
}

export async function monthReview(handles: DbHandles, workspaceId: string, asOf = todayKolkata()) {
  const start = kolkataMonthStart(asOf);
  const end = kolkataMonthEnd(asOf);
  const previousStart = kolkataMonthStart(kolkataAddMonths(start, -1));
  const previousEnd = kolkataMonthEnd(previousStart);
  const snapshot = await loadSnapshot(handles, workspaceId);
  const categoryName = new Map(snapshot.categories.map((category) => [category.id, category.name]));

  const grouped = new Map<string, number>();
  for (const posting of snapshot.postings) {
    if (posting.pnl !== "expense" || !posting.categoryId) continue;
    const event = snapshot.events.find((item) => item.id === posting.eventId);
    if (!event) continue;
    if (event.occurredOn < start || event.occurredOn > end) continue;
    grouped.set(posting.categoryId, (grouped.get(posting.categoryId) ?? 0) + posting.amountPaise);
  }

  const spentPaise = await expenseTotalForMonth(handles, workspaceId, start, end);
  const previousSpentPaise = await expenseTotalForMonth(
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

function cycleView(cycle: LedgerBillingCycle, snapshot?: LedgerSnapshot) {
  const reservedTowardCyclePaise = snapshot
    ? reservedTowardCycle(snapshot.reservations, cycle.id)
    : paise(0);
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
    reservedTowardCyclePaise,
    unfundedPaise: paise(Math.max(0, cycle.remainingPaise - reservedTowardCyclePaise)),
    mismatch: cycle.mismatch,
    status: cycle.status,
    lifecycle: cycle.lifecycle,
    ruleSnapshot: cycle.ruleSnapshot,
  };
}

export async function listCards(handles: DbHandles, workspaceId: string, asOf = todayKolkata()) {
  return listCardsFromSnapshot(await loadSnapshot(handles, workspaceId, asOf), asOf);
}

/** Active cards from an already-loaded snapshot — no DB access. */
export function listCardsFromSnapshot(snapshot: LedgerSnapshot, asOf = todayKolkata()) {
  const cards = [];
  for (const card of snapshot.creditCards.filter((item) => item.status === "active")) {
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
    const rule = snapshot.cardRules.find((item) => item.creditCardId === card.id)?.rule;
    if (!rule) {
      throw new DomainError("card_rule_missing", "This card has no statement or due rule for that date");
    }
    cards.push({
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
      currentCycle: current ? cycleView(current, snapshot) : null,
      nextDueOn: nextDue ?? current?.actualDueOn ?? current?.expectedDueOn ?? null,
      statementDay: rule.statementDay,
      dueDaysAfterStatement: rule.dueDaysAfterStatement,
    });
  }
  return cards;
}

export async function cardDetail(
  handles: DbHandles,
  workspaceId: string,
  cardId: string,
  asOf = todayKolkata(),
) {
  const snapshot = await loadSnapshot(handles, workspaceId, asOf);
  const card = snapshot.creditCards.find((item) => item.id === cardId);
  if (!card) {
    throw new DomainError("card_not_found", "Credit card not found");
  }
  const cycles = snapshot.billingCycles
    .filter((cycle) => cycle.creditCardId === card.id)
    .sort((left, right) => right.expectedStatementOn.localeCompare(left.expectedStatementOn));
  const outstandingPaise = sumPaise(cycles.map((cycle) => cycle.ledgerRemainingPaise));
  const rule =
    snapshot.cardRules.find((item) => item.creditCardId === card.id)?.rule ??
    (await loadCardRule(handles, workspaceId, card.id, asOf));
  const activity = (await listActivity(handles, workspaceId)).filter((event) =>
    snapshot.events.some(
      (item) => item.id === event.id && item.creditCardId === card.id,
    ),
  );
  // Opening-card provenance comes from the snapshot, not from `activity`:
  // listActivity deliberately omits opening meanings, so it can never reveal an
  // `apply_opening_card_position`.
  const baseOpeningCycleId =
    snapshot.events.find(
      (event) =>
        event.meaning === "apply_opening_card_position" &&
        event.creditCardId === card.id &&
        event.billingCycleId !== null,
    )?.billingCycleId ?? null;
  const openingPosition = baseOpeningCycleId
    ? deriveOpeningCardPosition(snapshot, baseOpeningCycleId)
    : null;
  const cardLifecycleStarted = cardHasLifecycleActivity(snapshot, card.id);
  const openingCardState = {
    hasBaseOpening: openingPosition?.baseEventId != null,
    billingCycleId: baseOpeningCycleId,
    currentEffectiveAmountPaise: openingPosition?.currentEffectiveAmountPaise ?? paise(0),
    baseEventId: openingPosition?.baseEventId ?? null,
    canSetOpening: openingPosition === null && !cardLifecycleStarted,
    canCorrectOpening: openingPosition !== null && !openingPosition.hasLifecycleActivity,
  };

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
    cycles: cycles.map((cycle) => cycleView(cycle, snapshot)),
    transactions: activity,
    openingCardState,
    openingReservations: snapshot.reservations
      .filter((r) => 
        r.obligationRef.type === "billing_cycle" && 
        cycles.some((c) => c.id === r.obligationRef.id) &&
        snapshot.events.some((e) => e.id === r.originatingEventId && (e.meaning === "apply_opening_reservation" || e.meaning === "correct_opening_reservation"))
      )
      .map(r => {
        const remainingPaise = r.amountOriginalPaise - r.amountConsumedPaise - r.amountReleasedPaise - r.amountReassignedPaise;
        const hasNormalTransactions = activity.some(a => !a.meaning.includes("opening"));
        // Only eligible for correction if no normal transactions have occurred yet, and no part of it has been consumed/reassigned/released (or rather, just hasn't been consumed by a normal payCard yet)
        const canCorrect = r.status === "active" && !hasNormalTransactions && r.amountConsumedPaise === 0 && r.amountReassignedPaise === 0;
        return {
          reservationId: r.id,
          sourceAccountId: r.sourceAccountId,
          billingCycleId: r.obligationRef.id,
          remainingPaise,
          status: r.status,
          originatingEventId: r.originatingEventId,
          canCorrect
        };
      }),
  };
}

export async function cycleDetail(
  handles: DbHandles,
  workspaceId: string,
  cycleId: string,
  asOf = todayKolkata(),
) {
  const snapshot = await loadSnapshot(handles, workspaceId, asOf);
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
    ...cycleView(cycle, snapshot),
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

/** Coming Up from an already-loaded snapshot — no DB access. */
export function comingUpFromSnapshot(
  snapshot: LedgerSnapshot,
  asOf = todayKolkata(),
  filter: ComingUpFilter = "all_open",
) {
  const items = comingUpItems(snapshot, asOf);
  return filterComingUp(items, snapshot, asOf, filter);
}

export async function comingUp(
  handles: DbHandles,
  workspaceId: string,
  asOf = todayKolkata(),
  filter: ComingUpFilter = "all_open",
) {
  const snapshot = await loadSnapshot(handles, workspaceId, asOf);
  return comingUpFromSnapshot(snapshot, asOf, filter);
}

/** Home Coming Up preview from an already-loaded snapshot — no DB access. */
export function comingUpPreviewFromSnapshot(snapshot: LedgerSnapshot, asOf = todayKolkata()) {
  return comingUpFromSnapshot(snapshot, asOf, "all_open").items.slice(0, 5);
}

export async function comingUpPreview(handles: DbHandles, workspaceId: string, asOf = todayKolkata()) {
  return comingUpPreviewFromSnapshot(await loadSnapshot(handles, workspaceId, asOf), asOf);
}

export async function obligationDetail(handles: DbHandles, workspaceId: string, instanceId: string) {
  const snapshot = await loadSnapshot(handles, workspaceId);
  const instance = snapshot.obligationInstances.find((item) => item.id === instanceId);
  if (!instance) {
    throw new DomainError("obligation_not_found", "Obligation not found");
  }
  const items = comingUpItems(snapshot, todayKolkata());
  const row = items.find((item) => item.instanceId === instance.id);
  const template = instance.templateId
    ? snapshot.obligationTemplates.find((item) => item.id === instance.templateId)
    : null;
  return {
    ...instance,
    remainingPaise: instance.status === "open" ? instance.amountPaise : 0,
    coming: row ?? null,
    template: template ?? null,
    defaultAccountId: template?.defaultAccountId ?? null,
  };
}

export async function comingCardPayments(
  handles: DbHandles,
  workspaceId: string,
  asOf = todayKolkata(),
) {
  return comingCardPaymentsFromSnapshot(await loadSnapshot(handles, workspaceId, asOf));
}

/** Coming card payments from an already-loaded snapshot — no DB access. */
export function comingCardPaymentsFromSnapshot(snapshot: LedgerSnapshot) {
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

/** People list from an already-loaded snapshot — no DB access. */
export function listPeopleFromSnapshot(snapshot: LedgerSnapshot) {
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

/** Home people preview from an already-loaded snapshot — no DB access. */
export function peoplePreviewFromSnapshot(snapshot: LedgerSnapshot) {
  return listPeopleFromSnapshot(snapshot)
    .filter((person) => person.netPaise !== 0)
    .sort((left, right) => Math.abs(right.netPaise) - Math.abs(left.netPaise))
    .slice(0, 2);
}

export async function listPeople(handles: DbHandles, workspaceId: string) {
  return listPeopleFromSnapshot(await loadSnapshot(handles, workspaceId));
}

export async function personDetail(handles: DbHandles, workspaceId: string, personId: string) {
  const snapshot = await loadSnapshot(handles, workspaceId);
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
      const linkedReservations = snapshot.reservations.filter(
        (reservation) => reservation.originatingClaimId === claim.id,
      );
      const reservation = linkedReservations[0];
      const reservationCycle =
        reservation?.obligationRef.type === "billing_cycle"
          ? snapshot.billingCycles.find((item) => item.id === reservation.obligationRef.id)
          : undefined;
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
        reservationAmountPaise: reservation?.amountOriginalPaise ?? null,
        reservationCardLabel: reservation
          ? cycleCardLabel(snapshot, reservation.obligationRef.id)
          : null,
        reservationDueOn: reservationCycle
          ? (reservationCycle.actualDueOn ?? reservationCycle.expectedDueOn)
          : null,
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
  const history = (await listActivity(handles, workspaceId)).filter((event) => eventIds.has(event.id));
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

export async function suggestPersonAllocations(
  handles: DbHandles,
  workspaceId: string,
  personId: string,
  amountPaise: number,
  direction: ClaimDirection,
) {
  const snapshot = await loadSnapshot(handles, workspaceId);
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

export async function listPendingSurplus(handles: DbHandles, workspaceId: string) {
  return listPendingSurplusFromSnapshot(await loadSnapshot(handles, workspaceId));
}

/** Pending surplus / Needs review from an already-loaded snapshot — no DB access. */
export function listPendingSurplusFromSnapshot(snapshot: LedgerSnapshot) {
  return snapshot.surplusCases
    .filter((item) => item.status === "pending")
    .map((item) => {
      const person = item.personId
        ? snapshot.people.find((row) => row.id === item.personId)
        : undefined;
      const account = item.sourceAccountId
        ? snapshot.accounts.find((row) => row.id === item.sourceAccountId)
        : undefined;
      const openClaims = item.personId
        ? snapshot.claims
            .filter(
              (claim) =>
                claim.personId === item.personId &&
                claim.status === "open" &&
                claim.openAmountPaise > 0 &&
                (item.sourceAccountId
                  ? claim.direction === "they_owe_user"
                  : claim.direction === "user_owes_them"),
            )
            .map((claim) => ({
              id: claim.id,
              label: claimLabel(claim, snapshot),
              openAmountPaise: claim.openAmountPaise,
            }))
        : [];
      const unpaidCycles =
        item.kind === "reservation_excess"
          ? snapshot.billingCycles
              .filter((cycle) => cycle.remainingPaise > 0)
              .map((cycle) => ({
                id: cycle.id,
                label: cycleCardLabel(snapshot, cycle.id),
                remainingPaise: cycle.remainingPaise,
              }))
          : [];
      return {
        id: item.id,
        amountPaise: item.amountPaise,
        kind: item.kind,
        explanation: item.explanation,
        personId: item.personId,
        personName: person?.name ?? null,
        accountId: item.sourceAccountId,
        accountName: account?.displayName ?? null,
        cashSittingInAccount: Boolean(item.sourceAccountId),
        openClaims,
        unpaidCycles,
        resolutions: [
          ...(openClaims.length > 0 ? (["apply_to_other_claim"] as const) : []),
          ...(item.personId ? (["convert_to_payable"] as const) : []),
          ...(item.sourceAccountId ? (["treat_as_mine_correction"] as const) : []),
          ...(item.kind === "reservation_excess" && unpaidCycles.length > 0
            ? (["reassign_reservation"] as const)
            : []),
        ],
      };
    });
}

export async function home(handles: DbHandles, workspaceId: string, asOf = todayKolkata()) {
  return timedPerf("readMs", async () => {
    // One snapshot for STS, Coming Up preview, and People preview.
    const snapshot = await loadSnapshot(handles, workspaceId, asOf);
    const sts = timedPerfSync("engineMs", () => evaluateSafeToSpend(snapshot, asOf));
    const coming = comingUpPreviewFromSnapshot(snapshot, asOf);
    const people = peoplePreviewFromSnapshot(snapshot);
    addDbQueries(2);
    const [month, previous] = await Promise.all([
      currentMonthSpend(handles, workspaceId, asOf),
      currentMonthSpend(handles, workspaceId, kolkataAddMonths(asOf, -1)),
    ]);
    const next = sts.fundingCycles.find((cycle) => cycle.id === sts.nextFundingCycleId);
    const active = sts.fundingCycles.find((cycle) => cycle.id === sts.activeFundingCycleId);
    const typicalPolicy = next ? policyAsOf(snapshot.incomePolicies, next.expectedWindowStart) : null;
    return {
      asOf,
      currentCycleSafeToSpend: sts.currentCycleSafeToSpend,
      liquidTotal: sts.liquidTotal,
      reservedTotal: sts.reservedTotal,
      availableLiquid: sts.availableLiquid,
      includedObligationsTotal: sts.includedObligationsTotal,
      salaryStatus: next?.status ?? active?.status ?? null,
      salaryWindowStart: sts.nextExpectedIncomeWindow.start,
      salaryWindowEnd: sts.nextExpectedIncomeWindow.end,
      salaryTypicalOn: next ? typicalOnForCycle(next, typicalPolicy) : null,
      expectedSalaryPaise: sts.nextExpectedIncomeWindow.expectedAmount,
      delayed: sts.delayedFundingCycleIds.length > 0,
      incomePolicyConfigured: sts.incomePolicyConfigured,
      riskFlags: sts.riskFlags,
      explanationItems: sts.explanationItems,
      includedObligations: sts.includedObligations,
      excludedFutureObligations: sts.excludedFutureObligations,
      coming,
      monthSpentPaise: month.spentPaise,
      previousMonthSpentPaise: previous.spentPaise,
      people,
      accounts: sts.accounts,
      fundingCycles: sts.fundingCycles,
    };
  });
}

/**
 * Money screen read model: one loadSnapshot, then derive all sections in memory.
 * Month spend is computed from the same snapshot (no second DB round-trip).
 */
export async function money(handles: DbHandles, workspaceId: string, asOf = todayKolkata()) {
  return timedPerf("readMs", async () => {
    const snapshot = await loadSnapshot(handles, workspaceId, asOf);
    return {
      asOf,
      accounts: listAccountsFromSnapshot(snapshot),
      categories: listCategoriesFromSnapshot(snapshot),
      cards: listCardsFromSnapshot(snapshot, asOf),
      comingCardPayments: comingCardPaymentsFromSnapshot(snapshot),
      people: listPeopleFromSnapshot(snapshot),
      surplus: listPendingSurplusFromSnapshot(snapshot),
      templates: listObligationTemplatesFromSnapshot(snapshot),
      month: currentMonthSpendFromSnapshot(snapshot, asOf),
    };
  });
}

/** Obligation templates from an already-loaded snapshot — no DB access. */
export function listObligationTemplatesFromSnapshot(snapshot: LedgerSnapshot) {
  return snapshot.obligationTemplates.map((template) => ({
    ...template,
    amountPaise: snapshot.obligationInstances
      .filter((instance) => instance.templateId === template.id && instance.status === "open")
      .sort((left, right) => left.dueOn.localeCompare(right.dueOn))[0]?.amountPaise ?? null,
  }));
}
