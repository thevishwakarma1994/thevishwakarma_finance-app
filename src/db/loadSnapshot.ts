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
  ObligationPriority,
  ObligationRefType,
  OpeningPosition,
  PersonStatus,
  ReservationStatus,
  SurplusKind,
  SurplusResolution,
  SurplusStatus,
} from "../domain/ledger/types.js";
import { isAccountOpeningPayload } from "../domain/ledger/types.js";
import { enrichClaim } from "../domain/claims/derive.js";
import { enrichReservation } from "../domain/reservations/derive.js";
import {
  accounts,
  billingCycles,
  categories,
  claims,
  creditCards,
  eventShares,
  financialEvents,
  fundingCycles,
  incomePolicies,
  openingPositions,
  obligationTemplates,
  obligationInstances as obligationInstanceTable,
  people,
  postings,
  reservationLedger,
  reservations,
  settlementAllocations,
  surplusCases,
} from "./schema.js";
import type { SqliteHandles } from "./client.js";
import { loadCardRule } from "./config.js";
import { parseDueRule } from "../domain/obligations/generate.js";

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
  const allocationRows = handles.db
    .select()
    .from(settlementAllocations)
    .where(eq(settlementAllocations.workspaceId, workspaceId))
    .all();
  const reservationRows = handles.db
    .select()
    .from(reservations)
    .where(eq(reservations.workspaceId, workspaceId))
    .all();
  const reservationLedgerRows = handles.db
    .select()
    .from(reservationLedger)
    .where(eq(reservationLedger.workspaceId, workspaceId))
    .all();
  const surplusRows = handles.db
    .select()
    .from(surplusCases)
    .where(eq(surplusCases.workspaceId, workspaceId))
    .all();
  const policyRows = handles.db
    .select()
    .from(incomePolicies)
    .where(eq(incomePolicies.workspaceId, workspaceId))
    .all();
  const fundingRows = handles.db
    .select()
    .from(fundingCycles)
    .where(eq(fundingCycles.workspaceId, workspaceId))
    .all();
  const templateRows = handles.db
    .select()
    .from(obligationTemplates)
    .where(eq(obligationTemplates.workspaceId, workspaceId))
    .all();
  const instanceRows = handles.db
    .select()
    .from(obligationInstanceTable)
    .where(eq(obligationInstanceTable.workspaceId, workspaceId))
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
    obligationInstanceId: row.obligationInstanceId,
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

  const loadedAllocations = allocationRows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    claimId: row.claimId,
    amountPaise: paise(row.amountPaise),
    createsReservation: row.createsReservation === 1,
    reservationId: row.reservationId,
  }));

  const ledgerClaims: LedgerClaim[] = claimRows.map((row) =>
    enrichClaim(
      {
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
      },
      loadedAllocations,
    ),
  );

  const ledgerReservations = reservationRows.map((row) =>
    enrichReservation({
      id: row.id,
      sourceAccountId: row.sourceAccountId,
      amountOriginalPaise: paise(row.amountOriginalPaise),
      amountConsumedPaise: paise(row.amountConsumedPaise),
      amountReleasedPaise: paise(row.amountReleasedPaise),
      amountReassignedPaise: paise(row.amountReassignedPaise),
      amountSurplusHeldPaise: paise(row.amountSurplusHeldPaise),
      status: row.status as ReservationStatus,
      obligationRef: {
        type: row.obligationRefType as ObligationRefType,
        id: row.obligationRefId,
      },
      originatingEventId: row.originatingEventId,
      originatingClaimId: row.originatingClaimId,
      createdOn: isoDate(row.createdOn),
    }),
  );

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
    settlementAllocations: loadedAllocations,
    reservations: ledgerReservations,
    reservationLedger: reservationLedgerRows.map((row) => ({
      id: row.id,
      reservationId: row.reservationId,
      eventId: row.eventId,
      deltaConsumedPaise: paise(row.deltaConsumedPaise),
      deltaReleasedPaise: paise(row.deltaReleasedPaise),
      deltaReassignedPaise: paise(row.deltaReassignedPaise),
      deltaSurplusHeldPaise: paise(row.deltaSurplusHeldPaise),
      createdAt: row.createdAt,
    })),
    surplusCases: surplusRows.map((row) => ({
      id: row.id,
      amountPaise: paise(row.amountPaise),
      kind: row.kind as SurplusKind,
      sourceAccountId: row.sourceAccountId,
      personId: row.personId,
      reservationId: row.reservationId,
      eventId: row.eventId,
      explanation: row.explanation,
      status: row.status as SurplusStatus,
      resolution: (row.resolution as SurplusResolution | null) ?? null,
      resolvedAt: row.resolvedAt,
      resolvedByEventId: row.resolvedByEventId,
    })),
    events,
    postings: ledgerPostings,
    openings,
    incomePolicies: policyRows.map((row) => ({
      id: row.id,
      expectedAmountPaise: paise(row.expectedAmountPaise),
      windowStartDay: row.windowStartDay,
      windowEndDay: row.windowEndDay,
      typicalDay: row.typicalDay,
      effectiveFrom: isoDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo ? isoDate(row.effectiveTo) : null,
    })),
    fundingCycles: fundingRows.map((row) => ({
      id: row.id,
      year: row.year,
      month: row.month,
      expectedWindowStart: isoDate(row.expectedWindowStart),
      expectedWindowEnd: isoDate(row.expectedWindowEnd),
      expectedAmountSnapshot: paise(row.expectedAmountSnapshot),
      actualArrivalOn: row.actualArrivalOn ? isoDate(row.actualArrivalOn) : null,
      actualAmountPaise: row.actualAmountPaise === null ? null : paise(row.actualAmountPaise),
      salaryEventId: row.salaryEventId,
    })),
    cardRules: cardRows.flatMap((row) => {
      try {
        return [{ creditCardId: row.id, rule: loadCardRule(handles, workspaceId, row.id, asOf) }];
      } catch {
        return [];
      }
    }),
    extraObligations: [],
    obligationTemplates: templateRows.map((row) => ({
      id: row.id,
      name: row.name,
      priority: row.priority as ObligationPriority,
      dueRule: parseDueRule(JSON.parse(row.dueRule) as unknown),
      defaultAccountId: row.defaultAccountId,
      loanId: row.loanId,
      effectiveFrom: isoDate(row.effectiveFrom),
      effectiveTo: row.effectiveTo ? isoDate(row.effectiveTo) : null,
    })),
    obligationInstances: instanceRows.map((row) => ({
      id: row.id,
      templateId: row.templateId,
      nameSnapshot: row.nameSnapshot,
      dueOn: isoDate(row.dueOn),
      amountPaise: paise(row.amountPaise),
      prioritySnapshot: row.prioritySnapshot as ObligationPriority,
      status: row.status as LedgerSnapshot["obligationInstances"][number]["status"],
      fundingCycleId: row.fundingCycleId,
      paidEventId: row.paidEventId,
    })),
    budgets: [],
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
