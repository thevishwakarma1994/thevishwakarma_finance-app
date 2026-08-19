/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import {
  APPEARANCE_STORAGE_KEY,
  applyThemeToDOM,
  getStoredAppearance,
  getSystemIsDark,
  resolveTheme,
  setStoredAppearance,
} from "../../src/ui/appearance.js";

const firebase = vi.hoisted(() => {
  let listener: ((user: User | null) => void) | null = null;
  return {
    configured: true,
    googleRedirect: Promise.resolve(null as User | null),
    currentIdToken: vi.fn(async (_forceRefresh?: boolean) => "token-a"),
    signOutFirebase: vi.fn(async () => {
      listener?.(null);
    }),
    signInWithEmail: vi.fn(async (_email?: string, _password?: string) => ({ user: { uid: "u1" } as User })),
    signUpWithEmail: vi.fn(async (_email?: string, _password?: string) => ({ user: { uid: "u1" } as User })),
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockApi() {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/me")) {
      return Promise.resolve(jsonResponse(200, { authenticated: true, userId: "u1", workspaceId: "ws1" }));
    }
    if (url.includes("/api/money")) {
      return Promise.resolve(
        jsonResponse(200, {
          asOf: "2026-08-16",
          accounts: [],
          categories: [],
          cards: [],
          comingCardPayments: [],
          people: [],
          surplus: [],
          templates: [],
          month: { asOf: "2026-08-16", month: "2026-08", spentPaise: 0 },
        })
      );
    }
    return Promise.resolve(jsonResponse(200, {}));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const user = { uid: "firebase-u1" } as User;

async function renderManagePage() {
  window.history.replaceState({}, "", "/money/manage");
  mockApi();
  render(<App />);
  await act(async () => {
    firebase.emit(user);
  });
}

function setupMatchMediaMock(initialMatches = false) {
  let changeListener: ((e: { matches: boolean }) => void) | null = null;
  const matchMediaMock = vi.fn((query: string) => {
    return {
      matches: initialMatches,
      media: query,
      onchange: null,
      addListener: vi.fn((fn) => {
        changeListener = fn;
      }),
      removeListener: vi.fn(),
      addEventListener: vi.fn((event, fn) => {
        if (event === "change") changeListener = fn;
      }),
      removeEventListener: vi.fn((event, fn) => {
        if (event === "change" && changeListener === fn) changeListener = null;
      }),
      dispatchEvent: vi.fn(),
    };
  });
  vi.stubGlobal("matchMedia", matchMediaMock);
  return {
    emitOSChange(isDark: boolean) {
      if (changeListener) {
        changeListener({ matches: isDark });
      }
    },
  };
}

describe("Appearance & Theme Mode (UX Stage C.1)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    firebase.reset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("A — missing preference defaults to system", () => {
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
    expect(getStoredAppearance()).toBe("system");
  });

  it("B — light preference resolves light", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("C — dark preference resolves dark", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("D — system follows prefers-color-scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("E & F — OS theme change updates system mode, but explicit light/dark ignores OS changes", () => {
    const { emitOSChange } = setupMatchMediaMock(false);
    expect(resolveTheme(getStoredAppearance(), getSystemIsDark())).toBe("light");

    setStoredAppearance("system");
    emitOSChange(true);

    // explicit setting ignores OS change
    setStoredAppearance("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");

    setStoredAppearance("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("G — preference persists to localStorage", () => {
    setStoredAppearance("dark");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("dark");
    expect(getStoredAppearance()).toBe("dark");

    setStoredAppearance("light");
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe("light");
    expect(getStoredAppearance()).toBe("light");
  });

  it("H — invalid stored value falls back safely to system", () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "invalid_theme_value");
    expect(getStoredAppearance()).toBe("system");
  });

  it("I & J — Appearance control exists under Manage → App and selecting appearance updates theme", async () => {
    setupMatchMediaMock(false);
    await renderManagePage();

    await waitFor(() => screen.getByRole("heading", { name: "Manage money" }));
    const appearanceBtn = screen.getByRole("button", { name: /Appearance/ });
    expect(appearanceBtn).toBeTruthy();
    expect(appearanceBtn.textContent).toContain("System");

    fireEvent.click(appearanceBtn);
    expect(screen.getByRole("dialog", { name: "Appearance" })).toBeTruthy();

    const darkOption = screen.getByRole("button", { name: "Dark" });
    fireEvent.click(darkOption);

    expect(getStoredAppearance()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    const updatedAppearanceBtn = screen.getByRole("button", { name: /Appearance/ });
    expect(updatedAppearanceBtn.textContent).toContain("Dark");
  });

  it("Test Amendment 7 — localStorage read failure does not break startup", () => {
    const originalGetItem = localStorage.getItem;
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: Access denied");
    });
    expect(getStoredAppearance()).toBe("system");
    localStorage.getItem = originalGetItem;
  });

  it("Test Amendment 7 — unavailable matchMedia falls back safely", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(getSystemIsDark()).toBe(false);
    expect(resolveTheme("system", getSystemIsDark())).toBe("light");
  });

  it("Test Amendment 7 — bootstrap System+dark resolves dark and System+light resolves light", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("Test Amendment 7 — applyThemeToDOM sets meta theme-color and color-scheme correctly", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#f5f5f6");
    document.head.appendChild(meta);

    applyThemeToDOM("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(meta.getAttribute("content")).toBe("#141416");

    applyThemeToDOM("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(meta.getAttribute("content")).toBe("#f5f5f6");
  });
});
