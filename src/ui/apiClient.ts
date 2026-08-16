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
};

export type Category = { id: string; name: string };

export type ActivityEvent = {
  id: string;
  meaning: "income" | "spend_account";
  occurredOn: string;
  amountPaise: number;
  accountName: string | null;
  merchant: string | null;
  categories: { name: string; amountPaise: number }[];
  incomeKind: "salary" | "other" | null;
};

export type MonthSpend = {
  asOf: string;
  month: string;
  spentPaise: number;
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

export function fetchActivity() {
  return request<{ events: ActivityEvent[] }>("/api/activity");
}

export function fetchMonth() {
  return request<MonthSpend>("/api/month");
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
