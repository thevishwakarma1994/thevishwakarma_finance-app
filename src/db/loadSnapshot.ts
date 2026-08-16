import { eq } from "drizzle-orm";
import { paise, addPaise } from "../domain/money/paise.js";
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
import type { DbHandles } from "./handles.js";
import { anyDb, queryAll, tables } from "./exec.js"; 
import { loadCardRule } from "./config.js";
import { parseDueRule } from "../domain/obligations/generate.js";
import { fromStoredPaise, fromStoredPaiseOrNull } from "./storedPaise.js";

export async function loadSnapshot(
  handles: DbHandles,
  workspaceId: string,
  asOf = todayKolkata(),
): Promise<LedgerSnapshot> {
  const t = tables(handles);
  const accountRows = await queryAll(handles, anyDb(handles).select().from(t.accounts).where(eq(t.accounts.workspaceId, workspaceId)));
  const cardRows = await queryAll(handles, anyDb(handles).select().from(t.creditCards).where(eq(t.creditCards.workspaceId, workspaceId)));
  const cycleRows = await queryAll(handles, anyDb(handles).select().from(t.billingCycles).where(eq(t.billingCycles.workspaceId, workspaceId)));
  const categoryRows = await queryAll(handles, anyDb(handles).select().from(t.categories).where(eq(t.categories.workspaceId, workspaceId)));
  const eventRows = await queryAll(handles, anyDb(handles).select().from(t.financialEvents).where(eq(t.financialEvents.workspaceId, workspaceId)));
  const postingRows = await queryAll(handles, anyDb(handles).select().from(t.postings).where(eq(t.postings.workspaceId, workspaceId)));
  const openingRows = await queryAll(handles, anyDb(handles).select().from(t.openingPositions).where(eq(t.openingPositions.workspaceId, workspaceId)));
  const peopleRows = await queryAll(handles, anyDb(handles).select().from(t.people).where(eq(t.people.workspaceId, workspaceId)));
  const claimRows = await queryAll(handles, anyDb(handles).select().from(t.claims).where(eq(t.claims.workspaceId, workspaceId)));
  const shareRows = await queryAll(handles, anyDb(handles).select().from(t.eventShares).where(eq(t.eventShares.workspaceId, workspaceId)));
  const allocationRows = await queryAll(handles, anyDb(handles).select().from(t.settlementAllocations).where(eq(t.settlementAllocations.workspaceId, workspaceId)));
  const reservationRows = await queryAll(handles, anyDb(handles).select().from(t.reservations).where(eq(t.reservations.workspaceId, workspaceId)));
  const reservationLedgerRows = await queryAll(handles, anyDb(handles).select().from(t.reservationLedger).where(eq(t.reservationLedger.workspaceId, workspaceId)));
  const surplusRows = await queryAll(handles, anyDb(handles).select().from(t.surplusCases).where(eq(t.surplusCases.workspaceId, workspaceId)));
  const policyRows = await queryAll(handles, anyDb(handles).select().from(t.incomePolicies).where(eq(t.incomePolicies.workspaceId, workspaceId)));
  const fundingRows = await queryAll(handles, anyDb(handles).select().from(t.fundingCycles).where(eq(t.fundingCycles.workspaceId, workspaceId)));
  const templateRows = await queryAll(handles, anyDb(handles).select().from(t.obligationTemplates).where(eq(t.obligationTemplates.workspaceId, workspaceId)));
  const instanceRows = await queryAll(handles, anyDb(handles).select().from(t.obligationInstances).where(eq(t.obligationInstances.workspaceId, workspaceId)));

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
          amountPaise: fromStoredPaise(payload.amountPaise),
          note: typeof payload.note === "string" ? payload.note : null,
        },
      };
    }
    return {
      id: row.id,
      effectiveOn: isoDate(row.effectiveOn),
      kind: row.kind as OpeningPosition["kind"],
      subjectId: row.subjectId,
      payload: { balancePaise: fromStoredPaise(payload.balancePaise) },
    };
  });

  const ledgerAccounts: LedgerAccount[] = accountRows.map((row) => {
    const opening = openings.find(
      (item) => item.kind === "account" && item.subjectId === row.id,
    );
    const openingBalancePaise =
      opening && isAccountOpeningPayload(opening.payload) ? opening.payload.balancePaise : paise(0);
    const postedPaise = postingRows
      .filter((posting) => posting.accountId === row.id)
      .reduce((sum, posting) => addPaise(sum, fromStoredPaise(posting.amountPaise)), paise(0));
    return {
      id: row.id,
      kind: row.kind as LedgerAccount["kind"],
      displayName: row.displayName,
      mask: row.mask,
      isPrimarySalary: row.isPrimarySalary === 1,
      status: row.status as LedgerAccount["status"],
      openingBalancePaise,
      postedPaise,
      balancePaise: addPaise(openingBalancePaise, postedPaise),
    };
  });

  const creditCardRecords: CreditCardRecord[] = cardRows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    issuer: row.issuer,
    mask: row.mask,
    creditLimitPaise: fromStoredPaiseOrNull(row.creditLimitPaise),
    defaultPaymentAccountId: row.defaultPaymentAccountId,
    defaultOwnerPersonId: row.defaultOwnerPersonId,
    status: row.status as CreditCardRecord["status"],
  }));

  const events = eventRows.map((row) => ({
    id: row.id,
    meaning: row.meaning as LedgerSnapshot["events"][number]["meaning"],
    occurredOn: isoDate(row.occurredOn),
    capturedAt: row.capturedAt,
    amountPaise: fromStoredPaise(row.amountPaise),
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
    amountPaise: fromStoredPaise(row.amountPaise),
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
    actualStatementAmountPaise: fromStoredPaiseOrNull(row.actualStatementAmountPaise),
    ruleSnapshot: parseCardCycleRule(JSON.parse(row.ruleSnapshot)),
  }));

  const loadedAllocations = allocationRows.map((row) => ({
    id: row.id,
    eventId: row.eventId,
    claimId: row.claimId,
    amountPaise: fromStoredPaise(row.amountPaise),
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
        originalAmountPaise: fromStoredPaise(row.originalAmountPaise),
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
      amountOriginalPaise: fromStoredPaise(row.amountOriginalPaise),
      amountConsumedPaise: fromStoredPaise(row.amountConsumedPaise),
      amountReleasedPaise: fromStoredPaise(row.amountReleasedPaise),
      amountReassignedPaise: fromStoredPaise(row.amountReassignedPaise),
      amountSurplusHeldPaise: fromStoredPaise(row.amountSurplusHeldPaise),
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

  const cardRules: LedgerSnapshot["cardRules"] = [];
  for (const row of cardRows) {
    try {
      cardRules.push({
        creditCardId: row.id,
        rule: await loadCardRule(handles, workspaceId, row.id, asOf),
      });
    } catch {
      // Cards without a rule are omitted from the snapshot, matching SQLite behavior.
    }
  }

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
      amountPaise: fromStoredPaise(row.amountPaise),
      isUser: row.isUser === 1,
    })),
    settlementAllocations: loadedAllocations,
    reservations: ledgerReservations,
    reservationLedger: reservationLedgerRows.map((row) => ({
      id: row.id,
      reservationId: row.reservationId,
      eventId: row.eventId,
      deltaConsumedPaise: fromStoredPaise(row.deltaConsumedPaise),
      deltaReleasedPaise: fromStoredPaise(row.deltaReleasedPaise),
      deltaReassignedPaise: fromStoredPaise(row.deltaReassignedPaise),
      deltaSurplusHeldPaise: fromStoredPaise(row.deltaSurplusHeldPaise),
      createdAt: row.createdAt,
    })),
    surplusCases: surplusRows.map((row) => ({
      id: row.id,
      amountPaise: fromStoredPaise(row.amountPaise),
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
      expectedAmountPaise: fromStoredPaise(row.expectedAmountPaise),
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
      expectedAmountSnapshot: fromStoredPaise(row.expectedAmountSnapshot),
      actualArrivalOn: row.actualArrivalOn ? isoDate(row.actualArrivalOn) : null,
      actualAmountPaise: fromStoredPaiseOrNull(row.actualAmountPaise),
      salaryEventId: row.salaryEventId,
    })),
    cardRules,
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
      amountPaise: fromStoredPaise(row.amountPaise),
      prioritySnapshot: row.prioritySnapshot as ObligationPriority,
      status: row.status as LedgerSnapshot["obligationInstances"][number]["status"],
      fundingCycleId: row.fundingCycleId,
      paidEventId: row.paidEventId,
    })),
    budgets: [],
  };
}

export async function getAccountBalance(
  handles: DbHandles,
  workspaceId: string,
  accountId: string,
): Promise<number> {
  const snapshot = await loadSnapshot(handles, workspaceId);
  const account = snapshot.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("Account not found");
  }
  return account.balancePaise;
}
