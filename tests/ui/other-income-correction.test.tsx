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

const incomeEvent = {
  id: "evt-income",
  meaning: "income",
  occurredOn: "2026-08-01",
  amountPaise: 500000,
  accountName: "HDFC",
  fromAccountName: "HDFC",
  toAccountName: null,
  cardLabel: null,
  merchant: null,
  categories: [],
  incomeKind: "other",
  shares: [],
  counterpartyName: null,
  otherOwned: false,
  personalAmountPaise: 0,
  rootEventId: "evt-income",
  effectiveEventId: "evt-income",
  corrected: false,
  correctionCount: 0,
  allocations: [],
};

const salaryEvent = {
  ...incomeEvent,
  id: "evt-salary",
  incomeKind: "salary",
  amountPaise: 800000,
  rootEventId: "evt-salary",
  effectiveEventId: "evt-salary",
};

const eligibleDetail: TransactionDetailView = {
  meaning: "income",
  occurredOn: "2026-08-01",
  amountPaise: 500000,
  accountId: "acc-hdfc",
  accountName: "HDFC",
  merchant: null,
  notes: "Freelance payment",
  categories: [],
  corrected: false,
  correctionCount: 0,
  canCorrect: true,
  correctionFamily: "other_income",
  refusalReason: null,
  rootEventId: "evt-income",
  targetEventId: "evt-income",
  history: [],
};

const salaryDetail: TransactionDetailView = {
  ...eligibleDetail,
  amountPaise: 800000,
  notes: null,
  canCorrect: false,
  correctionFamily: null,
  refusalReason: "This transaction can’t be corrected.",
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
const accountsBody = {
  accounts: [
    { id: "acc-hdfc", displayName: "HDFC", kind: "bank", mask: "2581", isPrimarySalary: true, balancePaise: 1500000, reservedPaise: 0, pendingSurplusPaise: 0, availablePaise: 1500000, reservedDetails: [], hasOpening: true },
    { id: "acc-pnb", displayName: "PNB", kind: "bank", mask: "1001", isPrimarySalary: false, balancePaise: 100000, reservedPaise: 0, pendingSurplusPaise: 0, availablePaise: 100000, reservedDetails: [], hasOpening: true },
  ],
};

describe("other-income correction UI", () => {
  beforeEach(() => {
    firebase.reset();
    window.history.replaceState({}, "", "/activity");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens eligible other income, prefills without a date field, previews amount and account-change impact, and keeps a stable commandId", async () => {
    let activity = [incomeEvent];
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
        if (url.includes("/api/accounts")) return Promise.resolve(jsonResponse(200, accountsBody));
        if (url.includes("/api/commands/income/correct") && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            commit: boolean;
            commandId: string;
            amountPaise: number;
            destinationAccountId: string;
          };
          posted.push(body);
          if (!body.commit) {
            const accountChanged = body.destinationAccountId === "acc-pnb";
            return Promise.resolve(jsonResponse(200, {
              committed: false,
              replayed: false,
              preview: {
                original: { amountPaise: 500000, accountId: "acc-hdfc", accountName: "HDFC", merchant: null, notes: "Freelance payment", occurredOn: "2026-08-01", categories: [] },
                corrected: {
                  amountPaise: body.amountPaise,
                  accountId: body.destinationAccountId,
                  accountName: accountChanged ? "PNB" : "HDFC",
                  merchant: null,
                  notes: "Freelance payment",
                  occurredOn: "2026-08-01",
                  categories: [],
                },
                impact: accountChanged
                  ? [{ kind: "account", label: "HDFC", deltaPaise: -500000 }, { kind: "account", label: "PNB", deltaPaise: 500000 }]
                  : [{ kind: "account", label: "HDFC", deltaPaise: -50000 }, { kind: "income", label: "Other income", deltaPaise: -50000 }],
                effects: [],
                classifications: { spent: 0, income: body.amountPaise, invested: 0, moved: 0 },
                warnings: [],
                narrative: [],
              },
            }));
          }
          activity = [{ ...incomeEvent, amountPaise: body.amountPaise, corrected: true, correctionCount: 1 }];
          detail = {
            ...eligibleDetail,
            amountPaise: body.amountPaise,
            accountId: body.destinationAccountId,
            accountName: body.destinationAccountId === "acc-pnb" ? "PNB" : "HDFC",
            corrected: true,
            correctionCount: 1,
            targetEventId: "evt-replacement",
            history: [{
              correctedOn: "2026-08-20",
              capturedAt: "2026-08-20T10:00:00.000Z",
              reason: "Wrong amount",
              previous: { amountPaise: 500000, accountId: "acc-hdfc", accountName: "HDFC", merchant: null, notes: "Freelance payment", occurredOn: "2026-08-01", categories: [] },
              next: { amountPaise: body.amountPaise, accountId: body.destinationAccountId, accountName: body.destinationAccountId === "acc-pnb" ? "PNB" : "HDFC", merchant: null, notes: "Freelance payment", occurredOn: "2026-08-01", categories: [] },
            }],
          };
          return Promise.resolve(jsonResponse(200, { committed: true, replayed: false, correctionId: "corr-1", replacementEventId: "evt-replacement", rootEventId: "evt-income" }));
        }
        if (url.includes("/api/activity/evt-income") || url.includes("/api/activity/evt-replacement")) {
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
    fireEvent.click(screen.getByText("Income"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Correct transaction" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Correct transaction" }));
    await waitFor(() => {
      expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeTruthy();
    });
    expect(document.querySelector("[data-screen='expense-correction-form']")).toBeNull();
    expect(screen.getByLabelText("Amount")).toBeTruthy();
    expect(screen.getByLabelText("Destination account")).toBeTruthy();
    expect(screen.getByLabelText("Notes")).toBeTruthy();
    expect(screen.getByLabelText("Reason for correction")).toBeTruthy();
    expect(screen.queryByLabelText("Category")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add category" })).toBeNull();
    expect(screen.queryByLabelText("Merchant")).toBeNull();
    expect(document.querySelector("input[type='date']")).toBeNull();
    expect(screen.queryByLabelText(/^date$/i)).toBeNull();
    const amount = document.querySelector("[data-screen='other-income-correction-form'] input") as HTMLInputElement;
    expect(amount.value).toBe("5000");
    fireEvent.change(amount, { target: { value: "4500" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => {
      expect(screen.getByTestId("correction-preview")).toBeTruthy();
    });
    expect(screen.getByTestId("correction-preview").textContent).toContain("₹4,500");
    expect(screen.getByTestId("correction-preview").textContent).toContain("HDFC");
    fireEvent.click(screen.getAllByRole("button", { name: "Back" })[1]!);
    await waitFor(() => {
      expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeTruthy();
    });
    fireEvent.change(document.querySelector("[data-screen='other-income-correction-form'] select") as HTMLSelectElement, {
      target: { value: "acc-pnb" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => {
      expect(screen.getByTestId("correction-preview").textContent).toContain("PNB");
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm correction" }));
    await waitFor(() => {
      expect(screen.getByTestId("correction-history")).toBeTruthy();
    });
    const commandIds = posted.map((item) => (item as { commandId: string }).commandId);
    expect(new Set(commandIds).size).toBe(1);
  });

  it("does not expose Correct transaction for salary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/me")) {
          return Promise.resolve(jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" }));
        }
        if (url.includes("/api/home")) return Promise.resolve(jsonResponse(200, homeBody));
        if (url.includes("/api/activity/evt-salary")) return Promise.resolve(jsonResponse(200, salaryDetail));
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
    expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeNull();
    expect(document.querySelector("[data-screen='expense-correction-form']")).toBeNull();
  });

  it("shows second-correction history and consumer-safe preview errors", async () => {
    const historyDetail: TransactionDetailView = {
      ...eligibleDetail,
      amountPaise: 450000,
      accountId: "acc-pnb",
      accountName: "PNB",
      corrected: true,
      correctionCount: 2,
      targetEventId: "evt-p2",
      history: [
        {
          correctedOn: "2026-08-20",
          capturedAt: "2026-08-20T10:00:00.000Z",
          reason: "Wrong amount",
          previous: { amountPaise: 500000, accountId: "acc-hdfc", accountName: "HDFC", merchant: null, notes: "Freelance payment", occurredOn: "2026-08-01", categories: [] },
          next: { amountPaise: 450000, accountId: "acc-hdfc", accountName: "HDFC", merchant: null, notes: "Freelance payment", occurredOn: "2026-08-01", categories: [] },
        },
        {
          correctedOn: "2026-08-20",
          capturedAt: "2026-08-20T11:00:00.000Z",
          reason: "Wrong account",
          previous: { amountPaise: 450000, accountId: "acc-hdfc", accountName: "HDFC", merchant: null, notes: "Freelance payment", occurredOn: "2026-08-01", categories: [] },
          next: { amountPaise: 450000, accountId: "acc-pnb", accountName: "PNB", merchant: null, notes: "Freelance payment", occurredOn: "2026-08-01", categories: [] },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.includes("/api/me")) {
          return Promise.resolve(jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" }));
        }
        if (url.includes("/api/home")) return Promise.resolve(jsonResponse(200, homeBody));
        if (url.includes("/api/accounts")) return Promise.resolve(jsonResponse(200, accountsBody));
        if (url.includes("/api/commands/income/correct") && method === "POST") {
          return Promise.resolve(jsonResponse(409, {
            error: "insufficient_available",
            message: "There is not enough money available in this account",
          }));
        }
        if (url.includes("/api/activity/evt-income")) return Promise.resolve(jsonResponse(200, historyDetail));
        if (url.includes("/api/activity")) {
          return Promise.resolve(jsonResponse(200, {
            events: [{ ...incomeEvent, amountPaise: 450000, accountName: "PNB", corrected: true, correctionCount: 2, effectiveEventId: "evt-p2" }],
          }));
        }
        return Promise.resolve(jsonResponse(200, {}));
      }),
    );
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByText("Income")).toBeTruthy();
    });
    fireEvent.click(screen.getByText("Income"));
    await waitFor(() => {
      expect(screen.getByTestId("correction-history")).toBeTruthy();
    });
    expect(screen.getByText("2 corrections")).toBeTruthy();
    expect(screen.getByText(/Wrong amount/)).toBeTruthy();
    expect(screen.getByText(/Wrong account/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Correct transaction" }));
    await waitFor(() => {
      expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeTruthy();
    });
    await waitFor(() => {
      const amount = document.querySelector("[data-screen='other-income-correction-form'] input") as HTMLInputElement;
      const destination = document.querySelector("[data-screen='other-income-correction-form'] select") as HTMLSelectElement;
      expect(amount.value).toBe("4500");
      expect(destination.value).toBe("acc-pnb");
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => {
      expect(screen.getByText("There is not enough money available in this account")).toBeTruthy();
    });
    expect(document.querySelector(".danger")?.textContent).toBe(
      "There is not enough money available in this account",
    );
  });
});
