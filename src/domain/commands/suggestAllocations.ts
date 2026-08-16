import { paise, type Paise } from "../money/paise.js";
import type { ClaimDirection, ClaimKind, LedgerClaim, LedgerSnapshot } from "../ledger/types.js";
import type { IsoDate } from "../calendar/isoDate.js";
import { isoDate } from "../calendar/isoDate.js";

export type SuggestableClaim = Pick<LedgerClaim, "id" | "openAmountPaise" | "kind" | "status"> & {
  occurredOn: IsoDate;
  expectedDueOn?: IsoDate | null;
};

export type SuggestedAllocation = {
  claimId: string;
  amountPaise: Paise;
};

function kindRank(kind: ClaimKind): number {
  if (kind === "card_share") return 0;
  if (kind === "shared_bill") return 1;
  if (kind === "direct_loan" || kind === "borrowing") return 2;
  if (kind === "opening") return 3;
  return 4;
}

function sortKey(claim: SuggestableClaim): string {
  const dueOrOccurred = claim.kind === "card_share" ? (claim.expectedDueOn ?? claim.occurredOn) : claim.occurredOn;
  return `${dueOrOccurred}:${kindRank(claim.kind).toString().padStart(2, "0")}:${claim.id}`;
}

export function suggestableClaimsFor(
  snapshot: LedgerSnapshot,
  personId: string,
  direction: ClaimDirection,
): SuggestableClaim[] {
  return snapshot.claims
    .filter((claim) => claim.personId === personId && claim.direction === direction)
    .map((claim) => {
      const event = claim.originatingEventId
        ? snapshot.events.find((item) => item.id === claim.originatingEventId)
        : undefined;
      const opening = snapshot.openings.find((item) => item.id === claim.openingPositionId);
      const cycle = claim.billingCycleId
        ? snapshot.billingCycles.find((item) => item.id === claim.billingCycleId)
        : undefined;
      return {
        id: claim.id,
        openAmountPaise: claim.openAmountPaise,
        kind: claim.kind,
        status: claim.status,
        occurredOn: event?.occurredOn ?? opening?.effectiveOn ?? isoDate("1970-01-01"),
        expectedDueOn: cycle?.actualDueOn ?? cycle?.expectedDueOn ?? null,
      };
    });
}

export function suggestAllocations(
  claims: SuggestableClaim[],
  settlementAmount: Paise,
): SuggestedAllocation[] {
  if (settlementAmount <= 0) return [];
  const ordered = claims
    .filter((claim) => claim.status === "open" && claim.openAmountPaise > 0)
    .slice()
    .sort((left, right) => sortKey(left).localeCompare(sortKey(right)));

  let remaining = settlementAmount;
  const suggestions: SuggestedAllocation[] = [];
  for (const claim of ordered) {
    if (remaining <= 0) break;
    const amountPaise = paise(Math.min(claim.openAmountPaise, remaining));
    if (amountPaise <= 0) continue;
    suggestions.push({ claimId: claim.id, amountPaise });
    remaining = paise(remaining - amountPaise);
  }
  return suggestions;
}
