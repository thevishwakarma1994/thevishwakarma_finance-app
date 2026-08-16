import type { EntityId } from "../ids.js";
import type { IsoDate } from "../calendar/isoDate.js";
import type { Paise } from "../money/paise.js";

export const EVENT_MEANINGS = [
  "spend_account",
  "spend_card",
  "split",
  "lend",
  "settlement_in",
  "income",
  "transfer",
  "pay_obligation",
  "refund",
  "borrow",
  "settlement_out",
  "surplus_resolution",
] as const;

export type EventMeaning = (typeof EVENT_MEANINGS)[number];

export const PNL_KINDS = [
  "income_salary",
  "income_other",
  "expense",
  "investment",
] as const;

export type PnlKind = (typeof PNL_KINDS)[number];

export type AccountKind = "bank" | "cash" | "investment";

export type AccountRecord = {
  id: EntityId;
  kind: AccountKind;
  displayName: string;
  mask: string | null;
  isPrimarySalary: boolean;
  status: "active" | "archived";
};

export type CategoryRecord = {
  id: EntityId;
  parentId: EntityId | null;
  name: string;
  archivedAt: string | null;
};

export type CardCycleRule = {
  statementDay: number;
  dueDaysAfterStatement: number;
};

export type CreditCardStatus = "active" | "inactive";

export type CreditCardRecord = {
  id: EntityId;
  displayName: string;
  issuer: string;
  mask: string | null;
  creditLimitPaise: Paise | null;
  defaultPaymentAccountId: EntityId | null;
  defaultOwnerPersonId: EntityId | null;
  status: CreditCardStatus;
};

export type PersonStatus = "active" | "archived";

export type PersonRecord = {
  id: EntityId;
  name: string;
  notes: string | null;
  status: PersonStatus;
};

export const CLAIM_DIRECTIONS = ["they_owe_user", "user_owes_them"] as const;
export type ClaimDirection = (typeof CLAIM_DIRECTIONS)[number];

export const CLAIM_KINDS = [
  "card_share",
  "shared_bill",
  "direct_loan",
  "borrowing",
  "opening",
  "surplus_payable",
] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const CLAIM_STATUSES = ["open", "settled", "void"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export type ClaimRecord = {
  id: EntityId;
  personId: EntityId;
  direction: ClaimDirection;
  kind: ClaimKind;
  originalAmountPaise: Paise;
  originatingEventId: EntityId | null;
  openingPositionId: EntityId | null;
  billingCycleId: EntityId | null;
  note: string | null;
  status: ClaimStatus;
};

export type LedgerClaim = ClaimRecord & {
  openAmountPaise: Paise;
};

export type EventShare = {
  id: EntityId;
  eventId: EntityId;
  personId: EntityId | null;
  amountPaise: Paise;
  isUser: boolean;
};

export type SettlementAllocation = {
  id: EntityId;
  eventId: EntityId;
  claimId: EntityId;
  amountPaise: Paise;
  createsReservation: boolean;
  reservationId: EntityId | null;
};

export type ClaimStatusUpdate = {
  id: EntityId;
  status: ClaimStatus;
};

export const OBLIGATION_REF_TYPES = ["billing_cycle", "obligation_instance"] as const;
export type ObligationRefType = (typeof OBLIGATION_REF_TYPES)[number];

export type ObligationRef = {
  type: ObligationRefType;
  id: EntityId;
};

export const RESERVATION_STATUSES = [
  "active",
  "consumed",
  "released",
  "surplus_pending",
  "reassigned",
  "cancelled",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export type ReservationRecord = {
  id: EntityId;
  sourceAccountId: EntityId;
  amountOriginalPaise: Paise;
  amountConsumedPaise: Paise;
  amountReleasedPaise: Paise;
  amountReassignedPaise: Paise;
  amountSurplusHeldPaise: Paise;
  status: ReservationStatus;
  obligationRef: ObligationRef;
  originatingEventId: EntityId | null;
  originatingClaimId: EntityId | null;
  createdOn: IsoDate;
};

export type LedgerReservation = ReservationRecord & {
  remainingPaise: Paise;
};

export type ReservationLedgerEntry = {
  id: EntityId;
  reservationId: EntityId;
  eventId: EntityId;
  deltaConsumedPaise: Paise;
  deltaReleasedPaise: Paise;
  deltaReassignedPaise: Paise;
  deltaSurplusHeldPaise: Paise;
  createdAt: string;
};

export type ReservationMutation = {
  id: EntityId;
  amountConsumedPaise: Paise;
  amountReleasedPaise: Paise;
  amountReassignedPaise: Paise;
  amountSurplusHeldPaise: Paise;
  status: ReservationStatus;
};

export const SURPLUS_KINDS = [
  "reservation_excess",
  "unallocated_settlement",
  "claim_overpayment",
] as const;
export type SurplusKind = (typeof SURPLUS_KINDS)[number];

export const SURPLUS_STATUSES = ["pending", "resolved"] as const;
export type SurplusStatus = (typeof SURPLUS_STATUSES)[number];

export const SURPLUS_RESOLUTIONS = [
  "apply_to_other_claim",
  "convert_to_payable",
  "treat_as_mine_correction",
  "reassign_reservation",
] as const;
export type SurplusResolution = (typeof SURPLUS_RESOLUTIONS)[number];

export type SurplusCaseRecord = {
  id: EntityId;
  amountPaise: Paise;
  kind: SurplusKind;
  sourceAccountId: EntityId | null;
  personId: EntityId | null;
  reservationId: EntityId | null;
  eventId: EntityId | null;
  explanation: string;
  status: SurplusStatus;
  resolution: SurplusResolution | null;
  resolvedAt: string | null;
  resolvedByEventId: EntityId | null;
};

export type SurplusCaseUpdate = {
  id: EntityId;
  amountPaise: Paise;
  status: SurplusStatus;
  resolution: SurplusResolution | null;
  resolvedAt: string | null;
  resolvedByEventId: EntityId | null;
};

export const BILLING_CYCLE_STATUSES = [
  "open",
  "statement_expected",
  "statement_confirmed",
  "due",
  "paid",
  "closed",
] as const;

export type BillingCycleStatus = (typeof BILLING_CYCLE_STATUSES)[number];

export const CYCLE_LIFECYCLES = [
  "accumulating",
  "statement_expected",
  "statement_recorded",
  "partially_paid",
  "paid",
  "overdue",
] as const;

export type CycleLifecycle = (typeof CYCLE_LIFECYCLES)[number];

export type BillingCycleRecord = {
  id: EntityId;
  creditCardId: EntityId;
  purchaseWindowStart: IsoDate;
  purchaseWindowEnd: IsoDate;
  expectedStatementOn: IsoDate;
  actualStatementOn: IsoDate | null;
  expectedDueOn: IsoDate;
  actualDueOn: IsoDate | null;
  actualStatementAmountPaise: Paise | null;
  ruleSnapshot: CardCycleRule;
};

export type LedgerBillingCycle = BillingCycleRecord & {
  expectedAmountPaise: Paise;
  amountPaidPaise: Paise;
  ledgerRemainingPaise: Paise;
  statementRemainingPaise: Paise;
  /** payCard payment cap: min(ledgerRemaining, statementRemaining). */
  remainingPaise: Paise;
  /** STS obligation: max(ledgerRemaining, statementRemaining). */
  obligationRemainingForSTS: Paise;
  mismatch: boolean;
  status: BillingCycleStatus;
  lifecycle: CycleLifecycle;
};

export type FinancialEvent = {
  id: EntityId;
  meaning: EventMeaning;
  occurredOn: IsoDate;
  capturedAt: string;
  amountPaise: Paise;
  /** For `transfer`, this is the source account. Destination is the positive account posting. */
  accountId: EntityId | null;
  creditCardId: EntityId | null;
  loanId: EntityId | null;
  billingCycleId: EntityId | null;
  fundingCycleId: EntityId | null;
  categoryId: EntityId | null;
  channel: string | null;
  merchant: string | null;
  notes: string | null;
  reversalOfEventId: EntityId | null;
};

export type Posting = {
  id: EntityId;
  eventId: EntityId;
  amountPaise: Paise;
  accountId: EntityId | null;
  creditCardId: EntityId | null;
  loanId: EntityId | null;
  pnl: PnlKind | null;
  categoryId: EntityId | null;
  claimId: EntityId | null;
  billingCycleId: EntityId | null;
};

export type OpeningKind = "account" | "credit_card" | "person" | "loan";

export type AccountOpeningPayload = {
  balancePaise: Paise;
};

export type PersonOpeningPayload = {
  direction: ClaimDirection;
  amountPaise: Paise;
  note?: string | null;
};

export type OpeningPosition = {
  id: EntityId;
  effectiveOn: IsoDate;
  kind: OpeningKind;
  subjectId: EntityId;
  payload: AccountOpeningPayload | PersonOpeningPayload;
};

export function isAccountOpeningPayload(
  payload: OpeningPosition["payload"],
): payload is AccountOpeningPayload {
  return "balancePaise" in payload;
}

export type LedgerAccount = AccountRecord & {
  openingBalancePaise: Paise;
  postedPaise: Paise;
  balancePaise: Paise;
};

export const FUNDING_CYCLE_STATUSES = [
  "upcoming",
  "window_open_unreceived",
  "salary_delayed",
  "active",
  "closed",
] as const;
export type FundingCycleStatus = (typeof FUNDING_CYCLE_STATUSES)[number];

export const OBLIGATION_PRIORITIES = ["must_pay", "committed", "planned"] as const;
export type ObligationPriority = (typeof OBLIGATION_PRIORITIES)[number];

export type IncomePolicy = {
  id: EntityId;
  expectedAmountPaise: Paise;
  windowStartDay: number;
  windowEndDay: number;
  typicalDay: number | null;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
};

export type FundingCycleRecord = {
  id: EntityId;
  year: number;
  month: number;
  expectedWindowStart: IsoDate;
  expectedWindowEnd: IsoDate;
  expectedAmountSnapshot: Paise;
  actualArrivalOn: IsoDate | null;
  actualAmountPaise: Paise | null;
  salaryEventId: EntityId | null;
};

export type LedgerFundingCycle = FundingCycleRecord & {
  status: FundingCycleStatus;
};

export type CardRuleBinding = {
  creditCardId: EntityId;
  rule: CardCycleRule;
};

export type ExtraObligation = {
  id: EntityId;
  name: string;
  dueOn: IsoDate;
  remainingPaise: Paise;
  reservedPaise: Paise;
  priority: ObligationPriority;
};

export type BudgetRecord = {
  categoryId: EntityId;
  calendarYear: number;
  calendarMonth: number;
  amountPaise: Paise;
};

export type FundingCycleUpdate = {
  id: EntityId;
  actualArrivalOn: IsoDate;
  actualAmountPaise: Paise;
  salaryEventId: EntityId;
};

export type LedgerSnapshot = {
  accounts: LedgerAccount[];
  categories: CategoryRecord[];
  creditCards: CreditCardRecord[];
  people: PersonRecord[];
  billingCycles: LedgerBillingCycle[];
  claims: LedgerClaim[];
  eventShares: EventShare[];
  settlementAllocations: SettlementAllocation[];
  reservations: LedgerReservation[];
  reservationLedger: ReservationLedgerEntry[];
  surplusCases: SurplusCaseRecord[];
  events: FinancialEvent[];
  postings: Posting[];
  openings: OpeningPosition[];
  incomePolicies: IncomePolicy[];
  fundingCycles: FundingCycleRecord[];
  cardRules: CardRuleBinding[];
  extraObligations: ExtraObligation[];
  budgets: BudgetRecord[];
};

export type ConsequenceEffect = {
  kind: "account" | "income" | "expense" | "opening" | "card" | "claim" | "reserved" | "surplus";
  label: string;
  deltaPaise: Paise;
};

export type ConsequencePreview = {
  effects: ConsequenceEffect[];
  classifications: {
    spent: Paise;
    income: Paise;
    invested: Paise;
    moved: Paise;
  };
  warnings: string[];
  narrative: string[];
};

export type ProposedBatch = {
  events: FinancialEvent[];
  postings: Posting[];
  openings: OpeningPosition[];
  billingCycles?: BillingCycleRecord[];
  claims?: ClaimRecord[];
  eventShares?: EventShare[];
  settlementAllocations?: SettlementAllocation[];
  claimStatusUpdates?: ClaimStatusUpdate[];
  reservations?: ReservationRecord[];
  reservationLedger?: ReservationLedgerEntry[];
  reservationUpdates?: ReservationMutation[];
  surplusCases?: SurplusCaseRecord[];
  surplusCaseUpdates?: SurplusCaseUpdate[];
  fundingCycles?: FundingCycleRecord[];
  fundingCycleUpdates?: FundingCycleUpdate[];
};

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export function emptyBatch(): ProposedBatch {
  return { events: [], postings: [], openings: [] };
}

export function accountBalance(account: LedgerAccount): Paise {
  return account.balancePaise;
}
