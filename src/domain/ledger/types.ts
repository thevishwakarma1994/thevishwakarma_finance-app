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
  status: CreditCardStatus;
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
  remainingPaise: Paise;
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

export type OpeningPosition = {
  id: EntityId;
  effectiveOn: IsoDate;
  kind: OpeningKind;
  subjectId: EntityId;
  payload: AccountOpeningPayload;
};

export type LedgerAccount = AccountRecord & {
  openingBalancePaise: Paise;
  postedPaise: Paise;
  balancePaise: Paise;
};

export type LedgerSnapshot = {
  accounts: LedgerAccount[];
  categories: CategoryRecord[];
  creditCards: CreditCardRecord[];
  billingCycles: LedgerBillingCycle[];
  events: FinancialEvent[];
  postings: Posting[];
  openings: OpeningPosition[];
};

export type ConsequenceEffect = {
  kind: "account" | "income" | "expense" | "opening" | "card";
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
