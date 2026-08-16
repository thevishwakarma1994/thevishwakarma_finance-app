import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";
import type { AccountAvailability } from "./liquidity.js";
import type {
  ExtraObligation,
  LedgerFundingCycle,
  ObligationPriority,
} from "../ledger/types.js";

export const EXPLANATION_GROUPS = [
  "in_this_number",
  "later_period",
  "not_received",
  "optional",
  "risk",
] as const;
export type ExplanationGroup = (typeof EXPLANATION_GROUPS)[number];

export type ExplanationSourceRef = {
  type:
    | "account"
    | "reservation"
    | "surplus"
    | "billing_cycle"
    | "obligation_instance"
    | "claim"
    | "person"
    | "funding_cycle"
    | "budget"
    | "category";
  id: string;
};

export type ExplanationItem = {
  group: ExplanationGroup;
  label: string;
  amountPaise: Paise;
  sign: 1 | -1;
  sourceRef: ExplanationSourceRef | null;
  accountId: string | null;
  cardId: string | null;
  cycleId: string | null;
  personId: string | null;
  claimId: string | null;
  fundingCycleId: string | null;
  obligationId: string | null;
  uncertainWindow: boolean;
};

export type ObligationImpact = {
  ref: { type: "billing_cycle" | "obligation_instance"; id: string };
  name: string;
  dueOn: IsoDate;
  grossRemaining: Paise;
  reservedLinked: Paise;
  unfunded: Paise;
  fundingCycleId: string | null;
  uncertainWindow: boolean;
  priority: ObligationPriority;
  includeInCurrentCycle: boolean;
  cardId: string | null;
  mismatch: boolean;
};

export type CycleProjection = {
  fundingCycleId: string;
  year: number;
  month: number;
  openingAvailableEstimate: Paise;
  expectedIncome: Paise;
  includedUnfunded: Paise;
  projectedSafeToSpend: Paise;
};

export type RiskFlag =
  | "expected_income_delayed"
  | "insufficient_for_must_pays"
  | "statement_mismatch"
  | "salary_schedule_not_configured";

export type SafeToSpendSnapshot = {
  asOf: IsoDate;
  activeFundingCycleId: string | null;
  nextFundingCycleId: string | null;
  accounts: AccountAvailability[];
  liquidTotal: Paise;
  reservedTotal: Paise;
  availableLiquid: Paise;
  includedObligations: ObligationImpact[];
  includedObligationsTotal: Paise;
  uncertainWindowItems: ObligationImpact[];
  currentCycleSafeToSpend: Paise;
  excludedFutureObligations: ObligationImpact[];
  unreceivedClaimsTotal: Paise;
  plannedNotSubtracted: ObligationImpact[];
  budgetsIgnored: { categoryId: string; spentPaise: Paise; targetPaise: Paise }[];
  nextExpectedIncomeWindow: {
    start: IsoDate | null;
    end: IsoDate | null;
    status: LedgerFundingCycle["status"] | null;
    expectedAmount: Paise;
  };
  delayedFundingCycleIds: string[];
  nextUnfailedCycleId: string | null;
  incomePolicyConfigured: boolean;
  fundingCycles: LedgerFundingCycle[];
  extraObligations: ExtraObligation[];
  riskFlags: RiskFlag[];
  explanationItems: ExplanationItem[];
};

export type AffordabilityProposal = {
  amountPaise: Paise;
  occurredOn: IsoDate;
  funding: { accountId: string } | { creditCardId: string };
  categoryId?: string | null;
  meaning: "spend_account" | "spend_card";
};

export type AffordabilityConclusion = {
  code: "blocked" | "tight" | "comfortable";
  currentFits: boolean;
  horizonHealthy: boolean;
  nextCycleHealthy: boolean;
  reasons: string[];
};

export type AffordabilityResult = {
  proposal: AffordabilityProposal;
  baseline: SafeToSpendSnapshot;
  afterCurrent: SafeToSpendSnapshot;
  currentCycleDelta: Paise;
  currentBufferAfter: Paise;
  horizonCycleIds: string[];
  cycleProjections: CycleProjection[];
  worstProjectedSafeToSpend: Paise;
  worstCycleId: string | null;
  nextCycleProjection: CycleProjection | null;
  nextCycleBuffer: Paise | null;
  conclusion: AffordabilityConclusion;
  explanationItems: ExplanationItem[];
};
