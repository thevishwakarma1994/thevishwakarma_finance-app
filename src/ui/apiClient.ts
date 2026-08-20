import { currentIdToken, signOutFirebase } from "./firebase.js";

export type ConsequencePreview = {
  effects: { kind: string; label: string; deltaPaise: number }[];
  classifications: { spent: number; income: number; invested: number; moved: number };
  warnings: string[];
  narrative: string[];
};

export type Account = {
  id: string;
  displayName: string;
  kind: string;
  mask: string | null;
  isPrimarySalary: boolean;
  balancePaise: number;
  reservedPaise: number;
  pendingSurplusPaise: number;
  availablePaise: number;
  reservedDetails: {
    reservationId: string;
    amountPaise: number;
    cardLabel: string;
    dueOn: string | null;
    personName: string | null;
    claimId: string | null;
  }[];
  hasOpening: boolean;
};

export type Category = {
  id: string;
  name: string;
  parentId: string | null;
  archivedAt: string | null;
};

export type EventMeaning =
  | "spend_card"
  | "spend_account"
  | "transfer"
  | "income"
  | "split"
  | "borrow"
  | "lend"
  | "settlement_in"
  | "settlement_out"
  | "pay_obligation"
  | "apply_opening_card_position"
  | "correct_opening_card_position"
  | "apply_opening_claim"
  | "correct_opening_claim"
  | "apply_opening_reservation"
  | "correct_opening_reservation";

export type ActivityEvent = {
  id: string;
  meaning: EventMeaning;
  occurredOn: string;
  amountPaise: number;
  accountName: string | null;
  fromAccountName: string | null;
  toAccountName: string | null;
  cardLabel: string | null;
  merchant: string | null;
  categories: { id: string | null; name: string; amountPaise: number }[];
  incomeKind: "salary" | "other" | null;
  shares: { personId: string | null; personName: string; amountPaise: number; isUser: boolean }[];
  counterpartyName: string | null;
  otherOwned: boolean;
  personalAmountPaise: number;
  rootEventId?: string;
  effectiveEventId?: string;
  corrected?: boolean;
  correctionCount?: number;
  allocations: {
    claimId: string;
    amountPaise: number;
    label: string;
    createsReservation?: boolean;
    reservedPaise?: number;
    cardLabel?: string | null;
  }[];
  surplusPaise?: number;
  consequences?: { kind: "reserved" | "available" | "needs_review"; amountPaise: number; label: string }[];
};

export type CardCycleView = {
  id: string;
  creditCardId: string;
  purchaseWindowStart: string;
  purchaseWindowEnd: string;
  expectedStatementOn: string;
  actualStatementOn: string | null;
  expectedDueOn: string;
  actualDueOn: string | null;
  dueOn: string;
  expectedAmountPaise: number;
  actualStatementAmountPaise: number | null;
  amountPaidPaise: number;
  ledgerRemainingPaise: number;
  statementRemainingPaise: number;
  remainingPaise: number;
  reservedTowardCyclePaise?: number;
  unfundedPaise?: number;
  mismatch: boolean;
  status: string;
  lifecycle: string;
  ruleSnapshot: { statementDay: number; dueDaysAfterStatement: number };
};

export type CardListItem = {
  id: string;
  displayName: string;
  issuer: string;
  mask: string | null;
  label: string;
  creditLimitPaise: number | null;
  defaultPaymentAccountId: string | null;
  defaultOwnerPersonId: string | null;
  defaultOwnerName: string | null;
  status: string;
  outstandingPaise: number;
  currentCycle: CardCycleView | null;
  nextDueOn: string | null;
  statementDay: number;
  dueDaysAfterStatement: number;
};

export type ComingCardPayment = {
  cycleId: string;
  cardId: string;
  cardLabel: string;
  dueOn: string;
  remainingPaise: number;
  ledgerRemainingPaise: number;
  statementRemainingPaise: number;
  expectedAmountPaise: number;
  actualStatementAmountPaise: number | null;
  mismatch: boolean;
  lifecycle: string;
};

export type MonthSpend = {
  asOf: string;
  month: string;
  spentPaise: number;
};

export type MonthReview = {
  asOf: string;
  month: string;
  spentPaise: number;
  previousMonth: string;
  previousSpentPaise: number;
  differencePaise: number;
  categories: { categoryId: string; name: string; spentPaise: number }[];
};

export type PersonListItem = {
  id: string;
  name: string;
  notes: string | null;
  status: "active" | "archived";
  theyOwePaise: number;
  youOwePaise: number;
  netPaise: number;
  openItemCount: number;
  group: "they_owe_you" | "you_owe" | "settled";
};

export type PersonClaim = {
  id: string;
  kind: string;
  direction: string;
  status: string;
  originalAmountPaise: number;
  settledAmountPaise: number;
  openAmountPaise: number;
  originatingEventId: string | null;
  originatingMeaning: string | null;
  originatingMerchant: string | null;
  occurredOn: string | null;
  billingCycleId: string | null;
  cycleStatementOn: string | null;
  cardLabel: string | null;
  note: string | null;
  reservationAmountPaise?: number | null;
  reservationCardLabel?: string | null;
  reservationDueOn?: string | null;
};

export type PersonDetail = PersonListItem & {
  hasOpening: boolean;
  openingEffectiveOn: string | null;
  openClaims: PersonClaim[];
  claims: PersonClaim[];
  history: ActivityEvent[];
};

export type CommandResult = {
  preview: ConsequencePreview;
  eventId: string | null;
  committed: boolean;
};

export type ExpenseCorrectionSideView = {
  amountPaise: number;
  accountId: string | null;
  accountName: string | null;
  merchant: string | null;
  notes: string | null;
  occurredOn: string;
  categories: { id: string | null; name: string; amountPaise: number }[];
};

export type ExpenseCorrectionPreview = {
  original: ExpenseCorrectionSideView;
  corrected: ExpenseCorrectionSideView;
  impact: { kind: string; label: string; deltaPaise: number }[];
  effects: { kind: string; label: string; deltaPaise: number }[];
  classifications: { spent: number; income: number; invested: number; moved: number };
  warnings: string[];
  narrative: string[];
};

export type ExpenseCorrectionResult = {
  preview: ExpenseCorrectionPreview;
  eventId: string | null;
  committed: boolean;
  replayed: boolean;
  rootEventId: string;
  effectiveEventId: string | null;
  correctionId: string | null;
  reversalEventId: string | null;
  replacementEventId: string | null;
  corrected: boolean;
  correctionCount: number;
};

export type TransactionDetailView = {
  meaning: EventMeaning;
  occurredOn: string;
  amountPaise: number;
  accountId: string | null;
  accountName: string | null;
  merchant: string | null;
  notes: string | null;
  categories: { id: string | null; name: string; amountPaise: number }[];
  corrected: boolean;
  correctionCount: number;
  canCorrect: boolean;
  refusalReason: string | null;
  rootEventId: string;
  targetEventId: string;
  history: {
    correctedOn: string;
    capturedAt: string;
    reason: string | null;
    previous: ExpenseCorrectionSideView;
    next: ExpenseCorrectionSideView;
  }[];
};

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function authorizedFetch(path: string, init: RequestInit, forceRefresh: boolean) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const token = await currentIdToken(forceRefresh);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(path, { ...init, headers });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  let response = await authorizedFetch(path, init, false);
  if (response.status === 401) {
    response = await authorizedFetch(path, init, true);
  }
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  } & T;
  const elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const enabled =
      params.has("perf") ||
      window.localStorage.getItem("PERF_TIMING") === "1";
    if (enabled) {
      const serverTiming = response.headers.get("server-timing");
      const summary = response.headers.get("x-perf-summary");
      const requestId = response.headers.get("x-request-id");
      const entry = {
        path,
        clientMs: Math.round(elapsed),
        status: response.status,
        requestId,
        serverTiming,
        summary,
        at: new Date().toISOString(),
      };
      const bucket = ((window as unknown as { __PERF_LOG__?: unknown[] }).__PERF_LOG__ ??= []);
      bucket.push(entry);
      console.info("[perf]", entry);
    }
  }
  if (response.status === 401) {
    if (path !== "/api/me") {
      unauthorizedHandler?.();
    }
    throw new ApiError(
      response.status,
      data.error ?? "unauthenticated",
      data.message ?? "Request failed",
    );
  }
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? "error", data.message ?? "Request failed");
  }
  return data;
}

export { ApiError };

export function getMe() {
  return request<{ authenticated: boolean; userId: string; workspaceId: string }>("/api/me");
}

export async function signOut() {
  await signOutFirebase();
}

export function fetchAccounts() {
  return request<{ accounts: Account[] }>("/api/accounts");
}

export function fetchCategories() {
  return request<{ categories: Category[] }>("/api/categories");
}

export function fetchActivity(filter: { categoryId?: string; month?: string } = {}) {
  const params = new URLSearchParams();
  if (filter.categoryId) params.set("categoryId", filter.categoryId);
  if (filter.month) params.set("month", filter.month);
  const query = params.toString();
  return request<{ events: ActivityEvent[] }>(`/api/activity${query ? `?${query}` : ""}`);
}

export function fetchTransactionDetail(eventId: string) {
  return request<TransactionDetailView>(`/api/activity/${encodeURIComponent(eventId)}`);
}

export function fetchMonth() {
  return request<MonthSpend>("/api/month");
}

export function fetchMonthReview(month?: string) {
  const query = month ? `?month=${encodeURIComponent(month)}` : "";
  return request<MonthReview>(`/api/month-review${query}`);
}

export function createAccount(body: {
  displayName: string;
  kind: "bank" | "cash";
  mask?: string | null;
  isPrimarySalary?: boolean;
  openingBalancePaise?: number;
  openingEffectiveOn?: string;
}) {
  return request<{ id: string }>("/api/accounts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAccount(body: {
  accountId: string;
  displayName?: string;
  isPrimarySalary?: boolean;
  status?: "active" | "archived";
}) {
  return request<{ id: string }>("/api/accounts/update", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function createCategory(body: { name: string; parentId?: string | null }) {
  return request<{ id: string }>("/api/categories", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateCategory(body: { categoryId: string; name?: string; archive?: boolean }) {
  return request<{ id: string }>("/api/categories/update", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchPeople() {
  return request<{ people: PersonListItem[] }>("/api/people");
}

export function fetchPerson(id: string) {
  return request<PersonDetail>(`/api/people/${id}`);
}

export function createPerson(body: { name: string; notes?: string | null }) {
  return request<{ id: string }>("/api/people", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updatePerson(body: {
  personId: string;
  name?: string;
  notes?: string | null;
  status?: "active" | "archived";
}) {
  return request<{ id: string }>("/api/people/update", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitOpening(body: {
  accountId: string;
  effectiveOn: string;
  balancePaise: number;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/opening", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitIncome(body: {
  commandId?: string;
  occurredOn: string;
  amountPaise: number;
  accountId: string;
  kind: "salary" | "other";
  notes?: string | null;
  fundingCycleId?: string;
  expectedYear?: number;
  expectedMonth?: number;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/income", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitExpense(body: {
  occurredOn: string;
  accountId: string;
  allocations: { categoryId: string; amountPaise: number }[];
  merchant?: string | null;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/expense", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitExpenseCorrection(body: {
  commandId: string;
  rootEventId: string;
  targetEventId: string;
  amountPaise: number;
  sourceAccountId: string;
  occurredOn: string;
  allocations: { categoryId: string; amountPaise: number }[];
  merchant?: string | null;
  notes?: string | null;
  reason?: string | null;
  commit: boolean;
}) {
  return request<ExpenseCorrectionResult>("/api/commands/expense/correct", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitTransfer(body: {
  occurredOn: string;
  amountPaise: number;
  fromAccountId: string;
  toAccountId: string;
  notes?: string | null;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/transfer", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchCards() {
  return request<{ cards: CardListItem[] }>("/api/cards");
}

export function fetchCard(id: string) {
  return request<
    CardListItem & {
      cycles: CardCycleView[];
      transactions: ActivityEvent[];
      openingCardState: {
        hasBaseOpening: boolean;
        billingCycleId: string | null;
        currentEffectiveAmountPaise: number;
        baseEventId: string | null;
        canSetOpening: boolean;
        canCorrectOpening: boolean;
      };
      openingReservations: {
        reservationId: string;
        sourceAccountId: string;
        billingCycleId: string;
        remainingPaise: number;
        status: string;
        originatingEventId: string | null;
        canCorrect: boolean;
      }[];
    }
  >(`/api/cards/${id}`);
}

export function fetchCycle(id: string) {
  return request<
    CardCycleView & {
      card: { id: string; label: string; displayName: string; mask: string | null };
      spends: {
        id: string;
        occurredOn: string;
        amountPaise: number;
        merchant: string | null;
        categories: { id: string | null; name: string; amountPaise: number }[];
      }[];
      payments: { id: string; occurredOn: string; amountPaise: number; accountName: string | null }[];
    }
  >(`/api/cycles/${id}`);
}

export function fetchComingCardPayments() {
  return request<{ items: ComingCardPayment[] }>("/api/coming-card-payments");
}

export function createCard(body: {
  displayName: string;
  issuer: string;
  mask?: string | null;
  creditLimitPaise?: number | null;
  defaultPaymentAccountId?: string | null;
  defaultOwnerPersonId?: string | null;
  statementDay: number;
  dueDaysAfterStatement: number;
}) {
  return request<{ id: string }>("/api/cards", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateCard(body: {
  cardId: string;
  displayName?: string;
  issuer?: string;
  mask?: string | null;
  creditLimitPaise?: number | null;
  defaultPaymentAccountId?: string | null;
  defaultOwnerPersonId?: string | null;
  status?: "active" | "inactive";
  statementDay?: number;
  dueDaysAfterStatement?: number;
  ruleEffectiveFrom?: string;
}) {
  return request<{ id: string }>("/api/cards/update", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitCardSpend(body: {
  occurredOn: string;
  creditCardId: string;
  allocations: { categoryId: string; amountPaise: number }[];
  amountPaise?: number;
  ownerPersonId?: string | null;
  merchant?: string | null;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/card-spend", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitPayCard(body: {
  occurredOn: string;
  creditCardId: string;
  billingCycleId: string;
  accountId: string;
  amountPaise: number;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/pay-card", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function confirmStatement(body: {
  cycleId: string;
  actualStatementAmountPaise: number;
  actualStatementOn: string;
  actualDueOn: string;
}) {
  return request<{
    cycleId: string;
    expectedAmountPaise: number;
    actualStatementAmountPaise: number;
    mismatch: boolean;
    warning: string | null;
  }>("/api/commands/confirm-statement", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitSplit(body: {
  occurredOn: string;
  amountPaise: number;
  source: { type: "account"; accountId: string } | { type: "card"; creditCardId: string };
  userSharePaise: number;
  personShares: { personId: string; amountPaise: number }[];
  allocations: { categoryId: string; amountPaise: number }[];
  merchant?: string | null;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/split", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitLend(body: {
  occurredOn: string;
  accountId: string;
  personId: string;
  amountPaise: number;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/lend", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitBorrow(body: {
  occurredOn: string;
  accountId: string;
  personId: string;
  amountPaise: number;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/borrow", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchSettlementSuggestion(
  personId: string,
  amountPaise: number,
  direction: "they_owe_user" | "user_owes_them",
) {
  const params = new URLSearchParams({
    amountPaise: String(amountPaise),
    direction,
  });
  return request<{
    allocations: { claimId: string; amountPaise: number }[];
    claims: { id: string; kind: string; openAmountPaise: number; label: string }[];
  }>(`/api/people/${personId}/suggest-allocations?${params.toString()}`);
}

export function previewOrCommitReceiveSettlement(body: {
  occurredOn: string;
  accountId: string;
  personId: string;
  amountPaise: number;
  allocations: { claimId: string; amountPaise: number }[];
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/receive-settlement", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitPaySettlement(body: {
  occurredOn: string;
  accountId: string;
  personId: string;
  amountPaise: number;
  allocations: { claimId: string; amountPaise: number }[];
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/pay-settlement", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type PendingSurplus = {
  id: string;
  amountPaise: number;
  kind: string;
  explanation: string;
  personId: string | null;
  personName: string | null;
  accountId: string | null;
  accountName: string | null;
  cashSittingInAccount: boolean;
  openClaims: { id: string; label: string; openAmountPaise: number }[];
  unpaidCycles: { id: string; label: string; remainingPaise: number }[];
  resolutions: string[];
};

export function fetchPendingSurplus() {
  return request<{ items: PendingSurplus[] }>("/api/surplus");
}

export type MoneyView = {
  asOf: string;
  accounts: Account[];
  categories: Category[];
  cards: CardListItem[];
  comingCardPayments: ComingCardPayment[];
  people: PersonListItem[];
  surplus: PendingSurplus[];
  templates: {
    id: string;
    name: string;
    priority: string;
    dueRule: { dayOfMonth: number };
    effectiveFrom: string;
    effectiveTo: string | null;
    amountPaise: number | null;
  }[];
  month: MonthSpend;
};

export function fetchMoney(asOf?: string) {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return request<MoneyView>(`/api/money${query}`);
}

export function previewOrCommitResolveSurplus(body: {
  surplusCaseId: string;
  resolution:
    | "apply_to_other_claim"
    | "convert_to_payable"
    | "treat_as_mine_correction"
    | "reassign_reservation";
  amountPaise?: number;
  claimId?: string;
  billingCycleId?: string;
  confirmed?: boolean;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/resolve-surplus", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type ComingUpItem = {
  kind: "obligation" | "billing_cycle";
  id: string;
  name: string;
  dueOn: string;
  amountPaise: number;
  remainingPaise: number;
  reservedPaise: number;
  unfundedPaise: number;
  type: "obligation" | "card";
  priority: "must_pay" | "committed" | "planned";
  fundingCycleId: string | null;
  fundingPeriodLabel: string | null;
  status: string;
  overdue: boolean;
  uncertainWindow: boolean;
  delayedSalary: boolean;
  cardId: string | null;
  cycleId: string | null;
  instanceId: string | null;
};

export type HomeView = {
  asOf: string;
  currentCycleSafeToSpend: number;
  liquidTotal: number;
  reservedTotal: number;
  availableLiquid: number;
  includedObligationsTotal: number;
  salaryStatus: string | null;
  salaryWindowStart: string | null;
  salaryWindowEnd: string | null;
  salaryTypicalOn: string | null;
  expectedSalaryPaise: number;
  delayed: boolean;
  incomePolicyConfigured: boolean;
  riskFlags: string[];
  explanationItems: {
    group: string;
    label: string;
    amountPaise: number;
    sign: number;
    uncertainWindow: boolean;
  }[];
  coming: ComingUpItem[];
  monthSpentPaise: number;
  previousMonthSpentPaise: number;
  people: PersonListItem[];
  accounts: { accountId: string; balancePaise: number; reservedActivePaise: number; pendingSurplusHeldPaise: number; availablePaise: number }[];
};

export function fetchHome(asOf?: string) {
  const query = asOf ? `?asOf=${asOf}` : "";
  return request<HomeView>(`/api/home${query}`);
}

export type SalaryReceivableCycle = {
  fundingCycleId: string | null;
  year: number;
  month: number;
  typicalOn: string;
  windowStart: string;
  windowEnd: string;
  expectedAmountPaise: number;
  status: string;
};

export type SalaryScheduleView = {
  primarySalaryAccount: { id: string; displayName: string; kind: string } | null;
  policy: {
    expectedAmountPaise: number;
    windowStartDay: number;
    typicalDay: number | null;
    windowEndDay: number;
    effectiveFrom: string;
  } | null;
  nextExpected: SalaryReceivableCycle | null;
  receivableCycles: SalaryReceivableCycle[];
};

export function fetchSalarySchedule(asOf?: string) {
  const query = asOf ? `?asOf=${asOf}` : "";
  return request<SalaryScheduleView>(`/api/salary-schedule${query}`);
}

export function applySalaryPolicy(body: {
  expectedAmountPaise: number;
  windowStartDay: number;
  typicalDay: number;
  windowEndDay: number;
  effectiveFrom: string;
}) {
  return request<{ policyId: string | null }>("/api/commands/salary-policy", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type AffordabilityView = {
  currentBufferAfter: number;
  baseline: { currentCycleSafeToSpend: number };
  afterCurrent: { currentCycleSafeToSpend: number };
  worstProjectedSafeToSpend: number;
  worstCycleId: string | null;
  cycleProjections: {
    fundingCycleId: string;
    year: number;
    month: number;
    expectedIncome: number;
    projectedSafeToSpend: number;
  }[];
  conclusion: { code: "blocked" | "tight" | "comfortable"; reasons: string[] };
};

export type ComingUpView = {
  asOf: string;
  filter: string;
  filterAvailable: boolean;
  filterUnavailableReason: string | null;
  items: ComingUpItem[];
};

export function fetchComingUp(filter = "all_open", asOf?: string) {
  const params = new URLSearchParams({ filter });
  if (asOf) params.set("asOf", asOf);
  return request<ComingUpView>(`/api/coming-up?${params.toString()}`);
}

export function fetchObligation(id: string) {
  return request<{
    id: string;
    templateId: string | null;
    nameSnapshot: string;
    dueOn: string;
    amountPaise: number;
    prioritySnapshot: string;
    status: string;
    remainingPaise: number;
    defaultAccountId: string | null;
  }>(`/api/obligations/${id}`);
}

export function fetchObligationTemplates() {
  return request<{
    templates: {
      id: string;
      name: string;
      priority: string;
      dueRule: { dayOfMonth: number };
      effectiveFrom: string;
      effectiveTo: string | null;
      amountPaise: number | null;
    }[];
  }>("/api/obligation-templates");
}

export function createObligationTemplate(body: {
  name: string;
  priority: "must_pay" | "committed" | "planned";
  dayOfMonth: number;
  amountPaise: number;
  defaultAccountId?: string | null;
  effectiveFrom: string;
}) {
  return request<{ id: string }>("/api/commands/obligation-templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function changeObligationFrom(body: {
  templateId: string;
  effectiveFrom: string;
  amountPaise?: number;
  priority?: "must_pay" | "committed" | "planned";
  name?: string;
}) {
  return request<{ id: string }>("/api/commands/obligation-templates/change", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function archiveObligationTemplate(body: { templateId: string; effectiveTo: string }) {
  return request<{ id: string }>("/api/commands/obligation-templates/archive", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function createOneOffObligation(body: {
  name: string;
  dueOn: string;
  amountPaise: number;
  priority: "must_pay" | "committed" | "planned";
}) {
  return request<{ id: string }>("/api/commands/obligation-one-off", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function previewOrCommitPayObligation(body: {
  occurredOn: string;
  instanceId: string;
  accountId: string;
  amountPaise: number;
  commit: boolean;
}) {
  return request<CommandResult>("/api/commands/pay-obligation", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function skipObligation(body: { instanceId: string }) {
  return request<{ id: string; status: string }>("/api/commands/skip-obligation", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function simulateAffordability(body: {
  amountPaise: number;
  occurredOn?: string;
  funding: { accountId: string } | { creditCardId: string };
  categoryId?: string;
}) {
  return request<AffordabilityView>("/api/commands/simulate-affordability", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function applyOpeningCard(body: { commandId: string; occurredOn: string; capturedAt: string; creditCardId: string; billingCycleId: string; amountPaise: number }) {
  return request<{ eventId: string | null }>("/api/commands/opening/card", { method: "POST", body: JSON.stringify(body) });
}

export function correctOpeningCard(body: { commandId: string; occurredOn: string; capturedAt: string; creditCardId: string; billingCycleId: string; targetAmountPaise: number }) {
  return request<{ eventId: string | null }>("/api/commands/opening/card/correct", { method: "POST", body: JSON.stringify(body) });
}

export function applyOpeningClaim(body: { commandId: string; occurredOn: string; capturedAt: string; personId: string; direction: "they_owe_user" | "user_owes_them"; amountPaise: number }) {
  return request<{ eventId: string | null }>("/api/commands/opening/claim", { method: "POST", body: JSON.stringify(body) });
}

export function correctOpeningClaim(body: { commandId: string; occurredOn: string; capturedAt: string; claimId: string; targetAmountPaise: number }) {
  return request<{ eventId: string | null }>("/api/commands/opening/claim/correct", { method: "POST", body: JSON.stringify(body) });
}

export function applyOpeningReservation(body: { commandId: string; occurredOn: string; capturedAt: string; sourceAccountId: string; cardId: string; billingCycleId: string; amountPaise: number }) {
  return request<{ eventId: string | null }>("/api/commands/opening/reservation", { method: "POST", body: JSON.stringify(body) });
}

export function correctOpeningReservation(body: { commandId: string; occurredOn: string; capturedAt: string; reservationId: string; targetAmountPaise: number }) {
  return request<{ eventId: string | null }>("/api/commands/opening/reservation/correct", { method: "POST", body: JSON.stringify(body) });
}
