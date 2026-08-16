import { paise } from "../money/paise.js";
import { DomainError } from "../ledger/types.js";
import type { IsoDate } from "../calendar/isoDate.js";
import { recordExpense } from "../commands/recordExpense.js";
import { recordCardSpend } from "../commands/recordCardSpend.js";
import { accountAvailability } from "./liquidity.js";
import { evaluateSafeToSpend } from "./evaluateSafeToSpend.js";
import { applyBatchOverlay, cloneSnapshot } from "./overlay.js";
import { horizonCycles, impactCycleForProposal, projectFundingCycle } from "./projectCycle.js";
import type {
  AffordabilityConclusion,
  AffordabilityProposal,
  AffordabilityResult,
  CycleProjection,
  ExplanationItem,
} from "./types.js";
import type { LedgerSnapshot } from "../ledger/types.js";

function capturedAt(occurredOn: IsoDate): string {
  return `${occurredOn}T00:00:00.000Z`;
}

function applyProposal(
  snapshot: LedgerSnapshot,
  proposal: AffordabilityProposal,
): { overlay: LedgerSnapshot; billingDueOn: IsoDate | null; reservedRaid: boolean; accountNegative: boolean } {
  const working = cloneSnapshot(snapshot);
  if (proposal.meaning === "spend_account" && "accountId" in proposal.funding) {
    const accountId = proposal.funding.accountId;
    const before = accountAvailability(working, accountId);
    const reservedRaid = proposal.amountPaise > before.availablePaise && proposal.amountPaise <= before.balancePaise;
    const categoryId = proposal.categoryId ?? working.categories.find((item) => !item.archivedAt)?.id;
    if (!categoryId) {
      throw new DomainError("category_not_found", "Category not found");
    }
    const account = working.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw new DomainError("account_not_found", "Account not found");
    }
    account.balancePaise = paise(account.balancePaise + proposal.amountPaise);
    account.postedPaise = paise(account.postedPaise + proposal.amountPaise);
    const result = recordExpense(
      {
        occurredOn: proposal.occurredOn,
        capturedAt: capturedAt(proposal.occurredOn),
        accountId,
        allocations: [{ categoryId, amountPaise: proposal.amountPaise }],
      },
      working,
    );
    const overlay = applyBatchOverlay(snapshot, result.batch, proposal.occurredOn);
    const afterAccount = accountAvailability(overlay, accountId);
    return {
      overlay,
      billingDueOn: null,
      reservedRaid,
      accountNegative: afterAccount.availablePaise < 0,
    };
  }

  if (proposal.meaning === "spend_card" && "creditCardId" in proposal.funding) {
    const creditCardId = proposal.funding.creditCardId;
    const rule = working.cardRules.find((item) => item.creditCardId === creditCardId)?.rule;
    if (!rule) {
      throw new DomainError("card_rule_missing", "This card has no statement or due rule for that date");
    }
    const categoryId = proposal.categoryId ?? working.categories.find((item) => !item.archivedAt)?.id;
    if (!categoryId) {
      throw new DomainError("category_not_found", "Category not found");
    }
    const result = recordCardSpend(
      {
        occurredOn: proposal.occurredOn,
        capturedAt: capturedAt(proposal.occurredOn),
        creditCardId,
        allocations: [{ categoryId, amountPaise: proposal.amountPaise }],
        rule,
      },
      working,
    );
    const overlay = applyBatchOverlay(snapshot, result.batch, proposal.occurredOn);
    const dueOn =
      overlay.billingCycles.find((cycle) => cycle.id === result.batch.events[0]?.billingCycleId)
        ?.expectedDueOn ?? null;
    return { overlay, billingDueOn: dueOn, reservedRaid: false, accountNegative: false };
  }

  throw new DomainError("invalid_input", "Proposal funding is missing");
}

function conclude(input: {
  afterSts: number;
  currentFits: boolean;
  horizonHealthy: boolean;
  reservedRaid: boolean;
  accountNegative: boolean;
  currentBufferAfter: number;
}): AffordabilityConclusion {
  const reasons: string[] = [];
  if (input.afterSts < 0) reasons.push("Safe to spend would go negative");
  if (input.accountNegative) reasons.push("The paying account would not have enough available money");
  if (input.reservedRaid) reasons.push("This would use money that is reserved or waiting for review");
  if (input.currentBufferAfter === 0 && input.currentFits) reasons.push("Nothing would remain before next salary");
  if (!input.horizonHealthy) reasons.push("A later salary period would not stay healthy");

  if (input.afterSts < 0 || input.accountNegative || input.reservedRaid) {
    return {
      code: "blocked",
      currentFits: input.currentFits,
      horizonHealthy: input.horizonHealthy,
      nextCycleHealthy: input.horizonHealthy,
      reasons,
    };
  }
  if (input.currentFits && (input.currentBufferAfter === 0 || !input.horizonHealthy)) {
    return {
      code: "tight",
      currentFits: true,
      horizonHealthy: input.horizonHealthy,
      nextCycleHealthy: input.horizonHealthy,
      reasons,
    };
  }
  return {
    code: "comfortable",
    currentFits: true,
    horizonHealthy: true,
    nextCycleHealthy: true,
    reasons: ["This fits current funds and later salary periods stay healthy"],
  };
}

export function simulateAffordability(
  snapshot: LedgerSnapshot,
  asOf: IsoDate,
  proposal: AffordabilityProposal,
): AffordabilityResult {
  const baseline = evaluateSafeToSpend(snapshot, asOf);
  const applied = applyProposal(snapshot, proposal);
  const afterCurrent = evaluateSafeToSpend(applied.overlay, asOf);
  const impact = impactCycleForProposal(afterCurrent, proposal.meaning, applied.billingDueOn);
  const horizon = horizonCycles(afterCurrent, impact);

  let carried = afterCurrent.availableLiquid;
  const cycleProjections: CycleProjection[] = [];
  for (const cycle of horizon) {
    const projected = projectFundingCycle({
      cycle,
      carriedAvailable: carried,
      after: afterCurrent,
      asOf,
    });
    cycleProjections.push(projected);
    carried = projected.projectedSafeToSpend;
  }

  const currentBufferAfter = afterCurrent.currentCycleSafeToSpend;
  const candidates: { id: string | null; value: number }[] = [
    { id: "current", value: currentBufferAfter },
    ...cycleProjections.map((item) => ({ id: item.fundingCycleId, value: item.projectedSafeToSpend })),
  ];
  const worst = candidates.reduce((best, item) => (item.value < best.value ? item : best));
  const horizonHealthy = cycleProjections.every((item) => item.projectedSafeToSpend >= 0);
  const currentFits = currentBufferAfter >= 0;
  const next = cycleProjections[0] ?? null;
  const conclusion = conclude({
    afterSts: currentBufferAfter,
    currentFits,
    horizonHealthy,
    reservedRaid: applied.reservedRaid,
    accountNegative: applied.accountNegative,
    currentBufferAfter,
  });

  const explanationItems: ExplanationItem[] = [
    ...afterCurrent.explanationItems,
    {
      group: "in_this_number",
      label: `Proposed ${proposal.meaning === "spend_card" ? "card" : "account"} spend`,
      amountPaise: paise(-proposal.amountPaise),
      sign: -1,
      sourceRef: null,
      accountId: "accountId" in proposal.funding ? proposal.funding.accountId : null,
      cardId: "creditCardId" in proposal.funding ? proposal.funding.creditCardId : null,
      cycleId: null,
      personId: null,
      claimId: null,
      fundingCycleId: impact?.id ?? null,
      obligationId: null,
      uncertainWindow: false,
    },
  ];

  return {
    proposal,
    baseline,
    afterCurrent,
    currentCycleDelta: paise(afterCurrent.currentCycleSafeToSpend - baseline.currentCycleSafeToSpend),
    currentBufferAfter,
    horizonCycleIds: horizon.map((cycle) => cycle.id),
    cycleProjections,
    worstProjectedSafeToSpend: paise(worst.value),
    worstCycleId: worst.id,
    nextCycleProjection: next,
    nextCycleBuffer: next ? next.projectedSafeToSpend : null,
    conclusion: {
      ...conclusion,
      nextCycleHealthy: next ? next.projectedSafeToSpend >= 0 : horizonHealthy,
    },
    explanationItems,
  };
}
