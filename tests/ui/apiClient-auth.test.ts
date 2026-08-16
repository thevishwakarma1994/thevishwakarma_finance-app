import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const currentIdToken = vi.fn<(forceRefresh?: boolean) => Promise<string | null>>();

vi.mock("../../src/ui/firebase.js", () => ({
  currentIdToken: (forceRefresh = false) => currentIdToken(forceRefresh),
  signOutFirebase: vi.fn(),
}));

import { fetchAccounts, getMe, setUnauthorizedHandler } from "../../src/ui/apiClient.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("apiClient Firebase token handling", () => {
  beforeEach(() => {
    currentIdToken.mockReset();
    currentIdToken.mockResolvedValue("token-a");
    setUnauthorizedHandler(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setUnauthorizedHandler(null);
  });

  it("E — authenticated requests send a Firebase bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { authenticated: true, userId: "u1", workspaceId: "w1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await getMe();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer token-a");
    expect(currentIdToken).toHaveBeenCalledWith(false);
  });

  it("F — each request asks Firebase for a token instead of reusing a stored string", async () => {
    currentIdToken.mockResolvedValueOnce("token-a").mockResolvedValueOnce("token-b");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { accounts: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { accounts: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAccounts();
    await fetchAccounts();
    const first = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const second = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(first.get("authorization")).toBe("Bearer token-a");
    expect(second.get("authorization")).toBe("Bearer token-b");
    expect(currentIdToken).toHaveBeenCalledTimes(2);
  });

  it("F — a 401 retries once with a forced token refresh", async () => {
    currentIdToken.mockResolvedValueOnce("stale").mockResolvedValueOnce("fresh");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { error: "unauthenticated" }))
      .mockResolvedValueOnce(jsonResponse(200, { accounts: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAccounts();
    expect(currentIdToken.mock.calls).toEqual([[false], [true]]);
    const retried = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(retried.get("authorization")).toBe("Bearer fresh");
  });
});
