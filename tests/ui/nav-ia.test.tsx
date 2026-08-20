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
    sendResetEmail: vi.fn(async () => undefined),
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
  sendResetEmail: () => firebase.sendResetEmail(),
  firebaseErrorMessage: (error: unknown) => firebase.firebaseErrorMessage(error),
}));

import { App } from "../../src/ui/App.js";

const homeBody = {
  asOf: "2026-08-16",
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
  riskFlags: ["salary_schedule_not_configured"],
  explanationItems: [],
  coming: [],
  monthSpentPaise: 0,
  previousMonthSpentPaise: 0,
  people: [],
  accounts: [],
};

const moneyBody = {
  asOf: "2026-08-16",
  accounts: [],
  categories: [],
  cards: [],
  comingCardPayments: [],
  people: [],
  surplus: [],
  templates: [],
  month: { asOf: "2026-08-16", month: "2026-08", spentPaise: 0 },
};

const personBody = {
  id: "p1",
  name: "Priya",
  notes: null,
  status: "active",
  netPaise: 700000,
  theyOwePaise: 700000,
  youOwePaise: 0,
  hasOpening: true,
  openingEffectiveOn: "2026-08-01",
  claims: [],
  openClaims: [],
  history: [],
};

const cardBody = {
  id: "c1",
  displayName: "ICICI",
  issuer: "ICICI",
  mask: "8001",
  label: "ICICI ·8001",
  creditLimitPaise: null,
  defaultPaymentAccountId: null,
  defaultOwnerPersonId: null,
  defaultOwnerName: null,
  status: "active",
  outstandingPaise: 1840000,
  currentCycle: null,
  nextDueOn: "2026-09-24",
  statementDay: 12,
  dueDaysAfterStatement: 18,
  cycles: [],
  transactions: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockApi(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    return Promise.resolve(handler(url));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const user = { uid: "firebase-u1" } as User;

async function renderReady(path = "/") {
  window.history.replaceState({}, "", path);
  const fetchMock = mockApi((url) => {
    if (url.includes("/api/me")) {
      return jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" });
    }
    if (url.includes("/api/home")) return jsonResponse(200, homeBody);
    if (url.includes("/api/money")) return jsonResponse(200, moneyBody);
    if (url.includes("/api/people/p1")) return jsonResponse(200, personBody);
    if (url.includes("/api/people")) return jsonResponse(200, { people: [] });
    if (url.includes("/api/cards/c1")) return jsonResponse(200, cardBody);
    if (url.includes("/api/cards")) return jsonResponse(200, { cards: [] });
    if (url.includes("/api/accounts")) return jsonResponse(200, { accounts: [] });
    if (url.includes("/api/categories")) return jsonResponse(200, { categories: [] });
    if (url.includes("/api/coming-card-payments")) return jsonResponse(200, { items: [] });
    if (url.includes("/api/obligation-templates")) return jsonResponse(200, { templates: [] });
    return jsonResponse(200, {});
  });
  render(<App />);
  await act(async () => {
    firebase.emit(user);
  });
  return fetchMock;
}

function navLabels(): string[] {
  return [...document.querySelectorAll("[data-primary-nav] a")].map((node) => node.textContent ?? "");
}

describe("UX Stage B navigation and IA", () => {
  beforeEach(() => {
    firebase.reset();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("A/B — exactly four primary tabs and Add is not a tab", async () => {
    await renderReady();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    });
    expect(navLabels()).toEqual(["Home", "Activity", "People", "Money"]);
    expect(screen.queryByRole("link", { name: "Add" })).toBeNull();
  });

  it("C — FAB exists only on root tabs", async () => {
    await renderReady();
    await waitFor(() => screen.getByRole("heading", { name: "Home" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Money" }));
    await waitFor(() => screen.getByRole("heading", { name: "Money" }));
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Manage money" }));
    await waitFor(() => screen.getByRole("heading", { name: "Manage money" }));
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("Money uses a gear control and FAB keeps a centered plus icon", async () => {
    await renderReady("/money");
    await waitFor(() => screen.getByRole("heading", { name: "Money" }));
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    const gear = screen.getByRole("button", { name: "Manage money" });
    expect(gear.querySelector("svg")).toBeTruthy();
    const fab = screen.getByRole("button", { name: "Add" });
    expect(fab.querySelector("svg")).toBeTruthy();
    expect(fab.textContent).toBe("");
    fireEvent.click(gear);
    await waitFor(() => screen.getByRole("heading", { name: "Manage money" }));
  });

  it("D — FAB opens grouped Add chooser and form returns to picker", async () => {
    await renderReady();
    await waitFor(() => screen.getByRole("heading", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("dialog", { name: "What happened?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I spent money" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Card spend" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I got paid" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "They paid me" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I lent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "I borrowed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I spent money" }));
    await waitFor(() => screen.getByRole("heading", { name: "I spent money" }));
    expect(document.querySelector("#add-form")?.classList.contains("sheet-form")).toBe(true);
    expect(document.querySelector("#add-form")?.closest(".card")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("dialog", { name: "What happened?" })).toBeTruthy();
  });

  it("E/M — Money initial load uses one /api/money fetch and no extra fan-out", async () => {
    const fetchMock = await renderReady("/money");
    await waitFor(() => screen.getByRole("heading", { name: "Money" }));
    const moneyCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/money"));
    expect(moneyCalls).toHaveLength(1);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/accounts"))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/cards"))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/api/categories"))).toBe(false);
  });

  it("F — Money overview does not render config forms", async () => {
    await renderReady("/money");
    await waitFor(() => screen.getByRole("heading", { name: "Money" }));
    expect(screen.queryByText("Add account")).toBeNull();
    expect(screen.queryByText("Create account")).toBeNull();
    expect(screen.queryByText("Add card")).toBeNull();
    expect(screen.queryByText("Create card")).toBeNull();
    expect(screen.queryByText("Add category")).toBeNull();
    expect(screen.queryByText("Add recurring")).toBeNull();
    expect(screen.queryByRole("button", { name: "Primary salary" })).toBeNull();
  });

  it("G — Manage routes to the correct screens", async () => {
    await renderReady("/money");
    await waitFor(() => screen.getByRole("heading", { name: "Money" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage money" }));
    await waitFor(() => screen.getByRole("heading", { name: "Manage money" }));
    fireEvent.click(screen.getByRole("button", { name: /Accounts/ }));
    await waitFor(() => screen.getByRole("heading", { name: "Accounts" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /Cards/ }));
    await waitFor(() => screen.getByRole("heading", { name: "Cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /Categories/ }));
    await waitFor(() => screen.getByRole("heading", { name: "Categories" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /Salary/ }));
    await waitFor(() => screen.getByRole("heading", { name: "Salary" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: /Bills/ }));
    await waitFor(() => screen.getByRole("heading", { name: "Bills" }));
  });

  it("H — contextual Person actions return to Person", async () => {
    await renderReady("/person/p1");
    await waitFor(() => screen.getByRole("heading", { name: "Priya" }));
    fireEvent.click(screen.getByRole("button", { name: "They paid me" }));
    await waitFor(() => screen.getByRole("heading", { name: "They paid me" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("heading", { name: "Priya" })).toBeTruthy();
  });

  it("I — contextual Card actions return to Card", async () => {
    await renderReady("/card/c1");
    await waitFor(() => screen.getByRole("heading", { name: "ICICI ·8001" }));
    fireEvent.click(screen.getByRole("button", { name: "Pay this card" }));
    await waitFor(() => screen.getByRole("heading", { name: "I paid a card" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("heading", { name: "ICICI ·8001" })).toBeTruthy();
  });

  it("J — Home salary warning routes to Salary", async () => {
    await renderReady("/");
    await waitFor(() => screen.getByRole("heading", { name: "Home" }));
    fireEvent.click(screen.getByRole("button", { name: "Salary schedule not configured" }));
    await waitFor(() => screen.getByRole("heading", { name: "Salary" }));
    expect(screen.getByText("Not configured")).toBeTruthy();
  });

  it("K — Sign out is not on Home or Money headers", async () => {
    await renderReady("/");
    await waitFor(() => screen.getByRole("heading", { name: "Home" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Money" }));
    await waitFor(() => screen.getByRole("heading", { name: "Money" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage money" }));
    await waitFor(() => screen.getByRole("heading", { name: "Manage money" }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
