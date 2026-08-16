import { paise, sumPaise, type Paise } from "../money/paise.js";
import { formatInr } from "../money/inr.js";
import { formatCardLabel, obligationRemainingForSTS } from "../cycle/lifecycle.js";
import { reservedTowardCycle } from "../reservations/derive.js";
import { accountAvailability } from "./liquidity.js";
import { q1Include, type InclusionContext } from "./inclusion.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type {
  ExtraObligation,
  LedgerBillingCycle,
  LedgerSnapshot,
  ObligationPriority,
} from "../ledger/types.js";
import {
  activeFundingCycle,
  assignFundingCycle,
  delayedFundingCycles,
  enrichFundingCycles,
  immediateNextFundingCycle,
  materializeFundingCycles,
  nextUnfailedCycle,
  openWindowCycle,
  policyAsOf,
} from "../funding/cycles.js";
import type {
  ExplanationItem,
  ObligationImpact,
  RiskFlag,
  SafeToSpendSnapshot,
} from "./types.js";

function liquidAccounts(snapshot: LedgerSnapshot) {
  return snapshot.accounts.filter(
    (account) => account.status === "active" && (account.kind === "bank" || account.kind === "cash"),
  );
}

function emptyItem(
  partial: Omit<ExplanationItem, "uncertainWindow"> & { uncertainWindow?: boolean },
): ExplanationItem {
  return { uncertainWindow: false, ...partial };
}

function billingImpacts(snapshot: LedgerSnapshot, context: InclusionContext): ObligationImpact[] {
  return snapshot.billingCycles
    .filter((cycle) => obligationRemainingForSTS(cycle.ledgerRemainingPaise, cycle.statementRemainingPaise) > 0)
    .map((cycle) => toBillingImpact(snapshot, cycle, context));
}

function toBillingImpact(
  snapshot: LedgerSnapshot,
  cycle: LedgerBillingCycle,
  context: InclusionContext,
): ObligationImpact {
  const card = snapshot.creditCards.find((item) => item.id === cycle.creditCardId);
  const dueOn = cycle.actualDueOn ?? cycle.expectedDueOn;
  const reservedLinked = reservedTowardCycle(snapshot.reservations, cycle.id);
  const assigned = assignFundingCycle(context.cycles, dueOn, context.asOf);
  const grossRemaining = obligationRemainingForSTS(
    cycle.ledgerRemainingPaise,
    cycle.statementRemainingPaise,
  );
  const unfunded = paise(Math.max(0, grossRemaining - reservedLinked));
  const decision = q1Include(
    {
      dueOn,
      fundingCycleId: assigned?.id ?? null,
      priority: "must_pay",
      remainingPaise: grossRemaining,
    },
    context,
  );
  const name = card ? formatCardLabel(card.displayName, card.mask) : "Card";
  return {
    ref: { type: "billing_cycle", id: cycle.id },
    name: `${name} due ${dueOn}`,
    dueOn,
    grossRemaining,
    reservedLinked,
    unfunded,
    fundingCycleId: assigned?.id ?? null,
    uncertainWindow: decision.uncertainWindow,
    priority: "must_pay",
    includeInCurrentCycle: decision.include && unfunded > 0,
    cardId: cycle.creditCardId,
    mismatch: cycle.mismatch,
  };
}

function extraImpacts(
  items: ExtraObligation[],
  context: InclusionContext,
): ObligationImpact[] {
  return items.map((item) => {
    const assigned = assignFundingCycle(context.cycles, item.dueOn, context.asOf);
    const unfunded = paise(Math.max(0, item.remainingPaise - item.reservedPaise));
    const decision = q1Include(
      {
        dueOn: item.dueOn,
        fundingCycleId: assigned?.id ?? null,
        priority: item.priority,
        remainingPaise: item.remainingPaise,
      },
      context,
    );
    return {
      ref: { type: "obligation_instance" as const, id: item.id },
      name: `${item.name} due ${item.dueOn}`,
      dueOn: item.dueOn,
      grossRemaining: item.remainingPaise,
      reservedLinked: item.reservedPaise,
      unfunded,
      fundingCycleId: assigned?.id ?? null,
      uncertainWindow: decision.uncertainWindow,
      priority: item.priority,
      includeInCurrentCycle: decision.include && item.priority !== "planned",
      cardId: null,
      mismatch: false,
    };
  });
}

function buildInclusionContext(
  snapshot: LedgerSnapshot,
  asOf: IsoDate,
): InclusionContext {
  const materialized = materializeFundingCycles(snapshot.incomePolicies, snapshot.fundingCycles, asOf);
  const cycles = enrichFundingCycles(materialized, asOf);
  return {
    asOf,
    cycles,
    active: activeFundingCycle(cycles),
    delayed: delayedFundingCycles(cycles),
    nextUnfailed: nextUnfailedCycle(cycles, asOf),
    openWindow: openWindowCycle(cycles, asOf),
  };
}

export function evaluateSafeToSpend(snapshot: LedgerSnapshot, asOf: IsoDate): SafeToSpendSnapshot {
  const inclusion = buildInclusionContext(snapshot, asOf);
  const { cycles } = inclusion;
  const accounts = liquidAccounts(snapshot).map((account) => accountAvailability(snapshot, account.id));
  const liquidTotal = sumPaise(accounts.map((account) => account.balancePaise));
  const reservedActive = sumPaise(accounts.map((account) => account.reservedActivePaise));
  const pendingSurplus = sumPaise(accounts.map((account) => account.pendingSurplusHeldPaise));
  const reservedTotal = paise(reservedActive + pendingSurplus);
  const availableLiquid = sumPaise(accounts.map((account) => account.availablePaise));

  const allImpacts = [
    ...billingImpacts(snapshot, inclusion),
    ...extraImpacts(snapshot.extraObligations, inclusion),
  ];
  const includedObligations = allImpacts.filter(
    (item) => item.includeInCurrentCycle && item.priority !== "planned",
  );
  const includedObligationsTotal = sumPaise(includedObligations.map((item) => item.unfunded));
  const currentCycleSafeToSpend = paise(availableLiquid - includedObligationsTotal);
  const excludedFutureObligations = allImpacts.filter(
    (item) => !item.includeInCurrentCycle && item.priority !== "planned" && item.grossRemaining > 0,
  );
  const plannedNotSubtracted = allImpacts.filter((item) => item.priority === "planned");
  const unreceivedClaimsTotal = sumPaise(
    snapshot.claims
      .filter((claim) => claim.status === "open" && claim.direction === "they_owe_user")
      .map((claim) => claim.openAmountPaise),
  );

  const incomePolicyConfigured = policyAsOf(snapshot.incomePolicies, asOf) !== null;
  const next = incomePolicyConfigured
    ? (inclusion.nextUnfailed ?? immediateNextFundingCycle(cycles))
    : inclusion.nextUnfailed;
  const active = inclusion.active;
  const delayedIds = inclusion.delayed.map((cycle) => cycle.id);
  const riskFlags: RiskFlag[] = [];
  if (!incomePolicyConfigured) riskFlags.push("salary_schedule_not_configured");
  if (delayedIds.length > 0) riskFlags.push("expected_income_delayed");
  if (currentCycleSafeToSpend < 0) riskFlags.push("insufficient_for_must_pays");
  if (snapshot.billingCycles.some((cycle) => cycle.mismatch)) riskFlags.push("statement_mismatch");

  const explanationItems = buildExplanation({
    snapshot,
    accounts,
    liquidTotal,
    includedObligations,
    excludedFutureObligations,
    plannedNotSubtracted,
    unreceivedClaimsTotal,
    currentCycleSafeToSpend,
    delayed: inclusion.delayed,
    next,
    incomePolicyConfigured,
  });

  return {
    asOf,
    activeFundingCycleId: active?.id ?? null,
    nextFundingCycleId: next?.id ?? null,
    accounts,
    liquidTotal,
    reservedTotal,
    availableLiquid,
    includedObligations,
    includedObligationsTotal,
    uncertainWindowItems: includedObligations.filter((item) => item.uncertainWindow),
    currentCycleSafeToSpend,
    excludedFutureObligations,
    unreceivedClaimsTotal,
    plannedNotSubtracted,
    budgetsIgnored: (snapshot.budgets ?? []).map((budget) => ({
      categoryId: budget.categoryId,
      spentPaise: paise(0),
      targetPaise: budget.amountPaise,
    })),
    nextExpectedIncomeWindow: {
      start: incomePolicyConfigured ? (next?.expectedWindowStart ?? null) : null,
      end: incomePolicyConfigured ? (next?.expectedWindowEnd ?? null) : null,
      status: incomePolicyConfigured ? (next?.status ?? null) : null,
      expectedAmount: incomePolicyConfigured ? (next?.expectedAmountSnapshot ?? paise(0)) : paise(0),
    },
    delayedFundingCycleIds: delayedIds,
    nextUnfailedCycleId: inclusion.nextUnfailed?.id ?? null,
    incomePolicyConfigured,
    fundingCycles: cycles,
    extraObligations: snapshot.extraObligations,
    riskFlags,
    explanationItems,
  };
}

function buildExplanation(input: {
  snapshot: LedgerSnapshot;
  accounts: ReturnType<typeof accountAvailability>[];
  liquidTotal: Paise;
  includedObligations: ObligationImpact[];
  excludedFutureObligations: ObligationImpact[];
  plannedNotSubtracted: ObligationImpact[];
  unreceivedClaimsTotal: Paise;
  currentCycleSafeToSpend: Paise;
  delayed: ReturnType<typeof delayedFundingCycles>;
  next: ReturnType<typeof nextUnfailedCycle>;
  incomePolicyConfigured: boolean;
}): ExplanationItem[] {
  const items: ExplanationItem[] = [];
  items.push(
    emptyItem({
      group: "in_this_number",
      label: "You have",
      amountPaise: input.liquidTotal,
      sign: 1,
      sourceRef: null,
      accountId: null,
      cardId: null,
      cycleId: null,
      personId: null,
      claimId: null,
      fundingCycleId: null,
      obligationId: null,
    }),
  );

  for (const account of input.accounts) {
    const snapshotAccount = input.snapshot.accounts.find((item) => item.id === account.accountId);
    for (const reservation of input.snapshot.reservations.filter(
      (item) => item.sourceAccountId === account.accountId && item.remainingPaise > 0,
    )) {
      const cycle =
        reservation.obligationRef.type === "billing_cycle"
          ? input.snapshot.billingCycles.find((item) => item.id === reservation.obligationRef.id)
          : undefined;
      const card = cycle
        ? input.snapshot.creditCards.find((item) => item.id === cycle.creditCardId)
        : undefined;
      const label = card
        ? `Reserved for ${formatCardLabel(card.displayName, card.mask)}`
        : `Reserved in ${snapshotAccount?.displayName ?? "account"}`;
      items.push(
        emptyItem({
          group: "in_this_number",
          label,
          amountPaise: paise(-reservation.remainingPaise),
          sign: -1,
          sourceRef: { type: "reservation", id: reservation.id },
          accountId: account.accountId,
          cardId: cycle?.creditCardId ?? null,
          cycleId: cycle?.id ?? null,
          personId: null,
          claimId: reservation.originatingClaimId,
          fundingCycleId: null,
          obligationId: reservation.obligationRef.id,
        }),
      );
    }
    if (account.pendingSurplusHeldPaise > 0) {
      items.push(
        emptyItem({
          group: "in_this_number",
          label: `Waiting for review in ${snapshotAccount?.displayName ?? "account"}`,
          amountPaise: paise(-account.pendingSurplusHeldPaise),
          sign: -1,
          sourceRef: { type: "surplus", id: account.accountId },
          accountId: account.accountId,
          cardId: null,
          cycleId: null,
          personId: null,
          claimId: null,
          fundingCycleId: null,
          obligationId: null,
        }),
      );
    }
  }

  for (const obligation of input.includedObligations) {
    items.push(
      emptyItem({
        group: "in_this_number",
        label: obligation.uncertainWindow
          ? `${obligation.name} — due during salary window`
          : obligation.name,
        amountPaise: paise(-obligation.unfunded),
        sign: -1,
        sourceRef: { type: obligation.ref.type, id: obligation.ref.id },
        accountId: null,
        cardId: obligation.cardId,
        cycleId: obligation.ref.type === "billing_cycle" ? obligation.ref.id : null,
        personId: null,
        claimId: null,
        fundingCycleId: obligation.fundingCycleId,
        obligationId: obligation.ref.id,
        uncertainWindow: obligation.uncertainWindow,
      }),
    );
  }

  for (const obligation of input.excludedFutureObligations) {
    items.push(
      emptyItem({
        group: "later_period",
        label: input.next
          ? `${obligation.name} — after next salary window`
          : `${obligation.name} — due later`,
        amountPaise: paise(-obligation.unfunded),
        sign: -1,
        sourceRef: { type: obligation.ref.type, id: obligation.ref.id },
        accountId: null,
        cardId: obligation.cardId,
        cycleId: obligation.ref.type === "billing_cycle" ? obligation.ref.id : null,
        personId: null,
        claimId: null,
        fundingCycleId: obligation.fundingCycleId,
        obligationId: obligation.ref.id,
      }),
    );
  }

  for (const claim of input.snapshot.claims.filter(
    (item) => item.status === "open" && item.direction === "they_owe_user" && item.openAmountPaise > 0,
  )) {
    const person = input.snapshot.people.find((item) => item.id === claim.personId);
    items.push(
      emptyItem({
        group: "not_received",
        label: `${person?.name ?? "Someone"} owes you ${formatInr(claim.openAmountPaise)}`,
        amountPaise: claim.openAmountPaise,
        sign: 1,
        sourceRef: { type: "claim", id: claim.id },
        accountId: null,
        cardId: null,
        cycleId: claim.billingCycleId,
        personId: claim.personId,
        claimId: claim.id,
        fundingCycleId: null,
        obligationId: null,
      }),
    );
  }

  for (const planned of input.plannedNotSubtracted) {
    items.push(
      emptyItem({
        group: "optional",
        label: `${planned.name} — planned, not subtracted`,
        amountPaise: paise(-planned.unfunded),
        sign: -1,
        sourceRef: { type: planned.ref.type, id: planned.ref.id },
        accountId: null,
        cardId: planned.cardId,
        cycleId: planned.ref.type === "billing_cycle" ? planned.ref.id : null,
        personId: null,
        claimId: null,
        fundingCycleId: planned.fundingCycleId,
        obligationId: planned.ref.id,
      }),
    );
  }

  for (const budget of input.snapshot.budgets ?? []) {
    const category = input.snapshot.categories.find((item) => item.id === budget.categoryId);
    items.push(
      emptyItem({
        group: "optional",
        label: `${category?.name ?? "Budget"} budget — not subtracted`,
        amountPaise: budget.amountPaise,
        sign: 1,
        sourceRef: { type: "budget", id: budget.categoryId },
        accountId: null,
        cardId: null,
        cycleId: null,
        personId: null,
        claimId: null,
        fundingCycleId: null,
        obligationId: null,
      }),
    );
  }

  if (!input.incomePolicyConfigured) {
    items.push(
      emptyItem({
        group: "risk",
        label: "Salary schedule not configured",
        amountPaise: paise(0),
        sign: 1,
        sourceRef: null,
        accountId: null,
        cardId: null,
        cycleId: null,
        personId: null,
        claimId: null,
        fundingCycleId: null,
        obligationId: null,
      }),
    );
  }

  for (const cycle of input.delayed) {
    items.push(
      emptyItem({
        group: "risk",
        label: `Salary expected ${cycle.expectedWindowStart}–${cycle.expectedWindowEnd} has not arrived`,
        amountPaise: paise(0),
        sign: 1,
        sourceRef: { type: "funding_cycle", id: cycle.id },
        accountId: null,
        cardId: null,
        cycleId: null,
        personId: null,
        claimId: null,
        fundingCycleId: cycle.id,
        obligationId: null,
      }),
    );
  }

  for (const cycle of input.snapshot.billingCycles.filter((item) => item.mismatch)) {
    const card = input.snapshot.creditCards.find((item) => item.id === cycle.creditCardId);
    items.push(
      emptyItem({
        group: "risk",
        label: `${card ? formatCardLabel(card.displayName, card.mask) : "Card"} statement needs review`,
        amountPaise: paise(0),
        sign: 1,
        sourceRef: { type: "billing_cycle", id: cycle.id },
        accountId: null,
        cardId: cycle.creditCardId,
        cycleId: cycle.id,
        personId: null,
        claimId: null,
        fundingCycleId: null,
        obligationId: cycle.id,
      }),
    );
  }

  if (input.currentCycleSafeToSpend < 0) {
    items.push(
      emptyItem({
        group: "risk",
        label: "Must-pays already exceed available money",
        amountPaise: input.currentCycleSafeToSpend,
        sign: -1,
        sourceRef: null,
        accountId: null,
        cardId: null,
        cycleId: null,
        personId: null,
        claimId: null,
        fundingCycleId: null,
        obligationId: null,
      }),
    );
  }

  return items;
}

export function inThisNumberTotal(items: ExplanationItem[]): Paise {
  return sumPaise(items.filter((item) => item.group === "in_this_number").map((item) => item.amountPaise));
}

export type { ObligationPriority };
