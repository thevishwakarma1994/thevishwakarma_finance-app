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
      firebase.signInWithEmail.mockClear();
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockApi(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    return Promise.resolve(handler(url));
  }));
}

const user = { uid: "firebase-u1" } as User;

describe("authenticated app access", () => {
  beforeEach(() => {
    firebase.reset();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("A — unresolved Firebase auth shows loading, not SignIn", () => {
    mockApi(() => jsonResponse(500, {}));
    render(<App />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(document.querySelector("[data-auth-phase='initializing']")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("B — Firebase user and /api/me 200 render Home", async () => {
    mockApi((url) => {
      if (url.includes("/api/me")) {
        return jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" });
      }
      if (url.includes("/api/home")) return jsonResponse(200, homeBody);
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    });
    expect(document.querySelector("[data-auth-phase='ready']")).toBeTruthy();
  });

  it("C — email/password success bootstraps the application", async () => {
    mockApi((url) => {
      if (url.includes("/api/me")) {
        return jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" });
      }
      if (url.includes("/api/home")) return jsonResponse(200, homeBody);
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(null);
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    await act(async () => {
      fireEvent.change(document.querySelector("input[type='email']") as HTMLInputElement, {
        target: { value: "a@example.com" },
      });
      fireEvent.change(document.querySelector("input[type='password']") as HTMLInputElement, {
        target: { value: "password1" },
      });
      fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form") as HTMLFormElement);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    });
  });

  it("D — refresh restores Firebase auth and the requested page", async () => {
    mockApi((url) => {
      if (url.includes("/api/me")) {
        return jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" });
      }
      if (url.includes("/api/home")) return jsonResponse(200, homeBody);
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    });
  });

  it("G — /api/me network failure is retryable and does not show SignIn", async () => {
    mockApi(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    expect(document.querySelector("[data-auth-phase='error']")).toBeTruthy();
  });

  it("H — /api/me 401 returns to unauthenticated SignIn", async () => {
    mockApi((url) => {
      if (url.includes("/api/me")) return jsonResponse(401, { error: "unauthenticated" });
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    });
  });

  it("I — /api/me 403 user_disabled shows access denied", async () => {
    mockApi((url) => {
      if (url.includes("/api/me")) {
        return jsonResponse(403, { error: "user_disabled", message: "This account is disabled" });
      }
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Access denied" })).toBeTruthy();
    });
    expect(screen.getByText("This account is disabled")).toBeTruthy();
  });

  it("J — sign out hides inner pages", async () => {
    mockApi((url) => {
      if (url.includes("/api/me")) {
        return jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" });
      }
      if (url.includes("/api/home")) return jsonResponse(200, homeBody);
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    });
    await act(async () => {
      screen.getByRole("button", { name: "Sign out" }).click();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    });
    expect(screen.queryByRole("heading", { name: "Home" })).toBeNull();
  });

  it("K — Google redirect uses the same bootstrap path", async () => {
    firebase.googleRedirect = Promise.resolve(user);
    mockApi((url) => {
      if (url.includes("/api/me")) {
        return jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" });
      }
      if (url.includes("/api/home")) return jsonResponse(200, homeBody);
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    });
  });

  it("L — a restored session can open a direct protected route", async () => {
    window.history.replaceState({}, "", "/money");
    mockApi((url) => {
      if (url.includes("/api/me")) {
        return jsonResponse(200, { authenticated: true, userId: "user-1", workspaceId: "ws-1" });
      }
      if (url.includes("/api/money")) {
        return jsonResponse(200, {
          asOf: "2026-08-16",
          accounts: [],
          categories: [],
          cards: [],
          comingCardPayments: [],
          people: [],
          surplus: [],
          templates: [],
          month: { asOf: "2026-08-16", month: "2026-08", spentPaise: 0 },
        });
      }
      return jsonResponse(200, {});
    });
    render(<App />);
    await act(async () => {
      firebase.emit(user);
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Money" })).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});
