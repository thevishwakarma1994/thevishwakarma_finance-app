/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";

const firebase = vi.hoisted(() => {
  let listener: ((user: User | null) => void) | null = null;
  return {
    configured: true,
    googleRedirect: Promise.resolve(null as User | null),
    currentIdToken: vi.fn(async (_forceRefresh = false) => "token-a"),
    signOutFirebase: vi.fn(async () => {
      listener?.(null);
    }),
    signInWithEmail: vi.fn(async (_email: string, _password: string) => ({ user: { uid: "u1" } as User })),
    signUpWithEmail: vi.fn(async (_email: string, _password: string) => ({ user: { uid: "u1" } as User })),
    signInWithGoogle: vi.fn(async () => ({ uid: "u1" }) as User),
    sendResetEmail: vi.fn(async (_email: string) => undefined),
    firebaseErrorMessage: (error: unknown) => (error instanceof Error ? error.message : "error"),
    emit(user: User | null) {
      listener?.(user);
    },
    subscribeAuth(next: (user: User | null) => void) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    completeGoogleRedirect() {
      return firebase.googleRedirect;
    },
    reset() {
      listener = null;
      firebase.configured = true;
      firebase.googleRedirect = Promise.resolve(null);
      firebase.currentIdToken.mockClear();
      firebase.signOutFirebase.mockClear();
    },
  };
});

vi.mock("../../src/ui/firebase.js", () => ({
  firebaseConfigured: () => firebase.configured,
  subscribeAuth: (listener: (user: User | null) => void) => firebase.subscribeAuth(listener),
  completeGoogleRedirect: () => firebase.completeGoogleRedirect(),
  currentIdToken: (forceRefresh = false) => firebase.currentIdToken(forceRefresh),
  signOutFirebase: () => firebase.signOutFirebase(),
  signInWithEmail: (email: string, password: string) => firebase.signInWithEmail(email, password),
  signUpWithEmail: (email: string, password: string) => firebase.signUpWithEmail(email, password),
  signInWithGoogle: () => firebase.signInWithGoogle(),
  sendResetEmail: (email: string) => firebase.sendResetEmail(email),
  firebaseErrorMessage: (error: unknown) => firebase.firebaseErrorMessage(error),
}));

import { App } from "../../src/ui/App.js";
import type { TransactionDetailView } from "../../src/ui/apiClient.js";

const homeBody = {
  asOf: "2026-08-20",
  currentCycleSafeToSpend: 0,
  liquidTotal: 0,
  reservedTotal: 0,
  availableLiquid: 0,
  includedObligationsTotal: 0,
  salaryStatus: null,
  salaryWindowStart: null,
  salaryWindowEnd: null,
  salaryTypicalOn: null,
  expectedSalaryPaise: 0,
  delayed: false,
  incomePolicyConfigured: false,
  riskFlags: [],
  explanationItems: [],
  coming: [],
  monthSpentPaise: 0,
  previousMonthSpentPaise: 0,
  people: [],
  accounts: [],
};

const expenseEvent = {
  id: "evt-effective",
  meaning: "spend_account",
  occurredOn: "2026-08-01",
  amountPaise: 185000,
  accountName: "HDFC",
  fromAccountName: "HDFC",
  toAccountName: null,
  cardLabel: null,
  merchant: "Cafe",
  categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 185000 }],
  incomeKind: null,
  shares: [],
  counterpartyName: null,
  otherOwned: false,
  personalAmountPaise: 185000,
  rootEventId: "evt-root",
  effectiveEventId: "evt-effective",
  corrected: false,
  correctionCount: 0,
  allocations: [],
};

const salaryEvent = {
  ...expenseEvent,
  id: "evt-salary",
  meaning: "income",
  incomeKind: "salary",
  merchant: null,
  categories: [],
  amountPaise: 800000,
  rootEventId: "evt-salary",
  effectiveEventId: "evt-salary",
};

const eligibleDetail: TransactionDetailView = {
  meaning: "spend_account",
  occurredOn: "2026-08-01",
  amountPaise: 185000,
  accountId: "acc-hdfc",
  accountName: "HDFC",
  merchant: "Cafe",
  notes: "lunch",
  categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 185000 }],
  corrected: false,
  correctionCount: 0,
  canCorrect: true,
  correctionFamily: "expense",
  refusalReason: null,
  rootEventId: "evt-root",
  targetEventId: "evt-effective",
  history: [],
};

const ineligibleDetail: TransactionDetailView = {
  ...eligibleDetail,
  meaning: "income",
  amountPaise: 800000,
  merchant: null,
  notes: null,
  categories: [],
  canCorrect: false,
  correctionFamily: null,
  refusalReason: "This transaction can’t be corrected because it has already affected another financial record.",
  rootEventId: "evt-salary",
  targetEventId: "evt-salary",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const user = { uid: "firebase-u1" } as User;

describe("expense correction UI", () => {
  beforeEach(() => {
    firebase.reset();
    window.history.replaceState({}, "", "/activity");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens an eligible expense, prefills the form without a date field, previews, and shows a corrected Activity row", async () => {
    let activity = [expenseEvent];
    let detail: TransactionDetailView = { ...eligibleDetail };
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/api/me")) {
          return Promise.resolve(jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" }));
        }
        if (url.includes("/api/home")) return Promise.resolve(jsonResponse(200, homeBody));
        if (url.includes("/api/accounts")) {
          return Promise.resolve(jsonResponse(200, { accounts: [{ id: "acc-hdfc", displayName: "HDFC", kind: "bank", mask: "2581", isPrimarySalary: true, balancePaise: 842000, reservedPaise: 0, pendingSurplusPaise: 0, availablePaise: 842000, reservedDetails: [], hasOpening: true }] }));
        }
        if (url.includes("/api/categories")) {
          return Promise.resolve(jsonResponse(200, { categories: [{ id: "cat-eating", name: "Eating Out", parentId: null, archivedAt: null }] }));
        }
        if (url.includes("/api/commands/expense/correct") && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { commit: boolean; commandId: string; amountPaise: number };
          posted.push(body);
          if (!body.commit) {
            return Promise.resolve(jsonResponse(200, {
              committed: false,
              replayed: false,
              preview: {
                original: { amountPaise: 185000, accountId: "acc-hdfc", accountName: "HDFC", merchant: "Cafe", notes: "lunch", occurredOn: "2026-08-01", categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 185000 }] },
                corrected: { amountPaise: 158000, accountId: "acc-hdfc", accountName: "HDFC", merchant: "Cafe", notes: "lunch", occurredOn: "2026-08-01", categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 158000 }] },
                impact: [{ kind: "account", label: "HDFC", deltaPaise: 27000 }, { kind: "expense", label: "Eating Out", deltaPaise: -27000 }],
                effects: [],
                classifications: { spent: 158000, income: 0, invested: 0, moved: 0 },
                warnings: [],
                narrative: [],
              },
            }));
          }
          activity = [{ ...expenseEvent, amountPaise: 158000, corrected: true, correctionCount: 1 }];
          detail = {
            ...eligibleDetail,
            amountPaise: 158000,
            corrected: true,
            correctionCount: 1,
            targetEventId: "evt-replacement",
            history: [{
              correctedOn: "2026-08-20",
              capturedAt: "2026-08-20T10:00:00.000Z",
              reason: null,
              previous: { amountPaise: 185000, accountId: "acc-hdfc", accountName: "HDFC", merchant: "Cafe", notes: "lunch", occurredOn: "2026-08-01", categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 185000 }] },
              next: { amountPaise: 158000, accountId: "acc-hdfc", accountName: "HDFC", merchant: "Cafe", notes: "lunch", occurredOn: "2026-08-01", categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 158000 }] },
            }],
          };
          return Promise.resolve(jsonResponse(200, { committed: true, replayed: false, correctionId: "corr-1", replacementEventId: "evt-replacement", rootEventId: "evt-root" }));
        }
        if (url.includes("/api/activity/evt-effective") || url.includes("/api/activity/evt-replacement")) {
          return Promise.resolve(jsonResponse(200, detail));
        }
        if (url.includes("/api/activity")) {
          return Promise.resolve(jsonResponse(200, { events: activity }));
        }
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );

    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Cafe"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Correct transaction" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Correct transaction" }));
    await waitFor(() => {
      expect(document.querySelector("[data-screen='expense-correction-form']")).toBeTruthy();
    });
    expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeNull();
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add category" })).toBeTruthy();
    expect(screen.getByLabelText("Merchant")).toBeTruthy();
    expect(document.querySelector("input[type='date']")).toBeNull();
    expect(screen.queryByLabelText(/date/i)).toBeNull();
    const amount = document.querySelector("[data-screen='expense-correction-form'] input") as HTMLInputElement;
    expect(amount.value).toBe("1850");
    fireEvent.change(amount, { target: { value: "1580" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => {
      expect(screen.getByTestId("correction-preview")).toBeTruthy();
    });
    expect(screen.getByTestId("correction-preview").textContent).toContain("₹1,580");
    expect(screen.getByTestId("correction-preview").textContent).toContain("Financial impact");
    fireEvent.click(screen.getByRole("button", { name: "Confirm correction" }));
    await waitFor(() => {
      expect(screen.getByTestId("correction-history")).toBeTruthy();
    });
    const commandIds = posted.map((item) => (item as { commandId: string }).commandId);
    expect(new Set(commandIds).size).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Correct transaction" }));
    await waitFor(() => {
      expect(document.querySelector("[data-screen='expense-correction-form']")).toBeTruthy();
    });
    const secondAmount = document.querySelector("[data-screen='expense-correction-form'] input") as HTMLInputElement;
    expect(secondAmount.value).toBe("1580");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(document.querySelector("[data-corrected='true']")).toBeTruthy();
    });
    expect(screen.getByText("Corrected")).toBeTruthy();
  });

  it("hides a usable correction action for an ineligible transaction", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/me")) {
          return Promise.resolve(jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" }));
        }
        if (url.includes("/api/home")) return Promise.resolve(jsonResponse(200, homeBody));
        if (url.includes("/api/activity/evt-salary")) return Promise.resolve(jsonResponse(200, ineligibleDetail));
        if (url.includes("/api/activity")) return Promise.resolve(jsonResponse(200, { events: [salaryEvent] }));
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByText("Salary")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Salary"));
    await waitFor(() => {
      expect(screen.getByText(/can’t be corrected/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Correct transaction" })).toBeNull();
  });
});
