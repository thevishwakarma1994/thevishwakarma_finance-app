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
  hasOpening: boolean;
};

export type Category = {
  id: string;
  name: string;
  parentId: string | null;
  archivedAt: string | null;
};

export type ActivityEvent = {
  id: string;
  meaning: "income" | "spend_account" | "transfer" | "spend_card" | "pay_obligation";
  occurredOn: string;
  amountPaise: number;
  accountName: string | null;
  fromAccountName: string | null;
  toAccountName: string | null;
  cardLabel: string | null;
  merchant: string | null;
  categories: { id: string | null; name: string; amountPaise: number }[];
  incomeKind: "salary" | "other" | null;
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

export type CommandResult = {
  preview: ConsequencePreview;
  eventId: string | null;
  committed: boolean;
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });
  if (response.status === 401 && path !== "/api/me" && path !== "/api/login") {
    if (window.location.pathname !== "/sign-in") {
      window.location.assign("/sign-in");
    }
  }
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
  } & T;
  if (!response.ok) {
    throw new ApiError(response.status, data.error ?? "error", data.message ?? "Request failed");
  }
  return data;
}

export { ApiError };

export function getMe() {
  return request<{ authenticated: boolean }>("/api/me");
}

export function signIn(password: string) {
  return request<{ ok: true }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export function signOut() {
  return request<{ ok: true }>("/api/logout", { method: "POST" });
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
  occurredOn: string;
  amountPaise: number;
  accountId: string;
  kind: "salary" | "other";
  notes?: string | null;
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
