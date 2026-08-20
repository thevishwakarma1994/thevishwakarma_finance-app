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
import { correctionFormFamily } from "../../src/ui/pages/TransactionDetail.js";
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

const user = { uid: "firebase-u1" } as User;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const smokeAccounts = {
  accounts: [
    {
      id: "acc-smoke",
      displayName: "Smoke Income Account",
      kind: "bank",
      mask: "0100",
      isPrimarySalary: false,
      balancePaise: 15000,
      reservedPaise: 0,
      pendingSurplusPaise: 0,
      availablePaise: 15000,
      reservedDetails: [],
      hasOpening: true,
    },
  ],
};

const smokeActivity = {
  id: "evt-smoke-income",
  meaning: "income",
  occurredOn: "2026-08-20",
  amountPaise: 5000,
  accountName: "Smoke Income Account",
  fromAccountName: "Smoke Income Account",
  toAccountName: null,
  cardLabel: null,
  merchant: null,
  categories: [],
  incomeKind: "other",
  shares: [],
  counterpartyName: null,
  otherOwned: false,
  personalAmountPaise: 0,
  rootEventId: "evt-smoke-income",
  effectiveEventId: "evt-smoke-income",
  corrected: false,
  correctionCount: 0,
  allocations: [],
};

const smokeDetail: TransactionDetailView = {
  meaning: "income",
  occurredOn: "2026-08-20",
  amountPaise: 5000,
  accountId: "acc-smoke",
  accountName: "Smoke Income Account",
  merchant: null,
  notes: null,
  categories: [],
  corrected: false,
  correctionCount: 0,
  canCorrect: true,
  correctionFamily: "other_income",
  refusalReason: null,
  rootEventId: "evt-smoke-income",
  targetEventId: "evt-smoke-income",
  history: [],
};

function stubReads(args: { activity: unknown[]; detail: unknown; extra?: (url: string) => Response | null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/me")) {
        return Promise.resolve(jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" }));
      }
      if (url.includes("/api/home")) return Promise.resolve(jsonResponse(200, homeBody));
      if (url.includes("/api/accounts")) return Promise.resolve(jsonResponse(200, smokeAccounts));
      if (url.includes("/api/categories")) {
        return Promise.resolve(
          jsonResponse(200, { categories: [{ id: "cat-eating", name: "Eating Out", parentId: null, archivedAt: null }] }),
        );
      }
      const extra = args.extra?.(url);
      if (extra) return Promise.resolve(extra);
      if (url.includes("/api/activity/") && !url.endsWith("/api/activity")) {
        return Promise.resolve(jsonResponse(200, args.detail));
      }
      if (url.includes("/api/activity")) {
        return Promise.resolve(jsonResponse(200, { events: args.activity }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    }),
  );
}

async function openActivityRow(label: string) {
  render(<App />);
  await act(async () => {
    firebase.emit(user);
  });
  await waitFor(() => {
    expect(screen.getByText(label)).toBeTruthy();
  });
  fireEvent.click(screen.getByText(label));
}

describe("correction form family dispatch", () => {
  beforeEach(() => {
    firebase.reset();
    window.history.replaceState({}, "", "/activity");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("routes only from the read-model family, never from canCorrect alone", () => {
    expect(correctionFormFamily({ canCorrect: true, correctionFamily: "expense" })).toBe("expense");
    expect(correctionFormFamily({ canCorrect: true, correctionFamily: "other_income" })).toBe("other_income");
    expect(correctionFormFamily({ canCorrect: true, correctionFamily: null })).toBeNull();
    expect(correctionFormFamily({ canCorrect: false, correctionFamily: "other_income" })).toBeNull();
    expect(correctionFormFamily({ canCorrect: true, correctionFamily: undefined as unknown as null })).toBeNull();
  });

  it("opens the other-income form for the production smoke ₹50 income, not expense categories", async () => {
    stubReads({ activity: [smokeActivity], detail: smokeDetail });
    await openActivityRow("Income");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Correct transaction" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Correct transaction" }));
    await waitFor(() => {
      expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeTruthy();
    });
    expect(document.querySelector("[data-screen='expense-correction-form']")).toBeNull();
    const amount = document.querySelector("[data-screen='other-income-correction-form'] input") as HTMLInputElement;
    expect(amount.value).toBe("50");
    await waitFor(() => {
      const destination = document.querySelector("[data-screen='other-income-correction-form'] select") as HTMLSelectElement;
      expect(destination.value).toBe("acc-smoke");
      expect(destination.textContent).toContain("Smoke Income Account");
    });
    expect(screen.getByLabelText("Notes")).toBeTruthy();
    expect(screen.getByLabelText("Reason for correction")).toBeTruthy();
    expect(screen.queryByLabelText("Category")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add category" })).toBeNull();
    expect(screen.queryByLabelText("Merchant")).toBeNull();
    expect(document.querySelector("input[type='date']")).toBeNull();
  });

  it("does not treat canCorrect as an expense form when correctionFamily is absent", async () => {
    const { correctionFamily: _family, ...withoutFamily } = smokeDetail;
    stubReads({ activity: [smokeActivity], detail: withoutFamily });
    await openActivityRow("Income");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Transaction" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Correct transaction" })).toBeNull();
    expect(document.querySelector("[data-screen='expense-correction-form']")).toBeNull();
    expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeNull();
    void _family;
  });

  it("opens ExpenseCorrectionForm only for correctionFamily expense", async () => {
    stubReads({
      activity: [
        {
          ...smokeActivity,
          id: "evt-expense",
          meaning: "spend_account",
          amountPaise: 185000,
          merchant: "Cafe",
          incomeKind: null,
          categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 185000 }],
        },
      ],
      detail: {
        ...smokeDetail,
        meaning: "spend_account",
        amountPaise: 185000,
        merchant: "Cafe",
        categories: [{ id: "cat-eating", name: "Eating Out", amountPaise: 185000 }],
        correctionFamily: "expense",
        rootEventId: "evt-expense",
        targetEventId: "evt-expense",
      },
    });
    await openActivityRow("Cafe");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Correct transaction" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "Correct transaction" }));
    await waitFor(() => {
      expect(document.querySelector("[data-screen='expense-correction-form']")).toBeTruthy();
    });
    expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeNull();
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.getByLabelText("Merchant")).toBeTruthy();
  });

  it("does not mount either correction form for salary", async () => {
    stubReads({
      activity: [{ ...smokeActivity, id: "evt-salary", incomeKind: "salary", amountPaise: 800000 }],
      detail: {
        ...smokeDetail,
        amountPaise: 800000,
        canCorrect: false,
        correctionFamily: null,
        refusalReason: "This transaction can’t be corrected.",
        rootEventId: "evt-salary",
        targetEventId: "evt-salary",
      },
    });
    await openActivityRow("Salary");
    await waitFor(() => {
      expect(screen.getByText(/can’t be corrected/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Correct transaction" })).toBeNull();
    expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeNull();
    expect(document.querySelector("[data-screen='expense-correction-form']")).toBeNull();
  });

  it("does not mount a correction form for unsupported families such as transfer", async () => {
    stubReads({
      activity: [
        {
          ...smokeActivity,
          id: "evt-transfer",
          meaning: "transfer",
          incomeKind: null,
          fromAccountName: "HDFC",
          toAccountName: "PNB",
          accountName: null,
        },
      ],
      detail: {
        ...smokeDetail,
        meaning: "transfer",
        canCorrect: false,
        correctionFamily: null,
        refusalReason: "This transaction can’t be corrected.",
        rootEventId: "evt-transfer",
        targetEventId: "evt-transfer",
      },
    });
    await openActivityRow("Moved money");
    await waitFor(() => {
      expect(screen.getByText(/can’t be corrected/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Correct transaction" })).toBeNull();
    expect(document.querySelector("[data-screen='expense-correction-form']")).toBeNull();
    expect(document.querySelector("[data-screen='other-income-correction-form']")).toBeNull();
  });
});
