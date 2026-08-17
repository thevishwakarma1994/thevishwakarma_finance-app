import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentIdToken = vi.fn<(forceRefresh?: boolean) => Promise<string | null>>();

vi.mock("../../src/ui/firebase.js", () => ({
  currentIdToken: (forceRefresh = false) => currentIdToken(forceRefresh),
  signOutFirebase: vi.fn(),
}));

import { fetchMoney } from "../../src/ui/apiClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Money client fetchMoney", () => {
  beforeEach(() => {
    currentIdToken.mockReset();
    currentIdToken.mockResolvedValue("token-a");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("A — fetchMoney issues exactly one /api/money HTTP request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
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
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchMoney();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/money");
  });
});
