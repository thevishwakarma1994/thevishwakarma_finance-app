import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/ui/apiClient.js";
import {
  classifyMeError,
  initialAuthState,
  reduceAuth,
  type AuthState,
} from "../../src/ui/authSession.js";

function ready(): AuthState {
  return reduceAuth(initialAuthState, { type: "me_success", userId: "user-1", workspaceId: "ws-1" });
}

describe("auth session reducer", () => {
  it("A — stays initializing until Firebase auth state resolves", () => {
    expect(initialAuthState.phase).toBe("initializing");
    expect(reduceAuth(initialAuthState, { type: "firebase_user" }).phase).toBe("bootstrap_loading");
  });

  it("does not treat the unresolved state as signed-out", () => {
    expect(initialAuthState.phase).not.toBe("unauthenticated");
  });

  it("K — Google and email both enter bootstrap through firebase_user", () => {
    const afterGoogle = reduceAuth(initialAuthState, { type: "firebase_user" });
    const afterEmail = reduceAuth(initialAuthState, { type: "firebase_user" });
    expect(afterGoogle).toEqual(afterEmail);
    expect(afterGoogle.phase).toBe("bootstrap_loading");
  });

  it("B — /api/me success becomes ready", () => {
    const loading = reduceAuth(initialAuthState, { type: "firebase_user" });
    const next = reduceAuth(loading, { type: "me_success", userId: "user-1", workspaceId: "ws-1" });
    expect(next.phase).toBe("ready");
    expect(next.userId).toBe("user-1");
    expect(next.workspaceId).toBe("ws-1");
  });

  it("G — retryable /api/me failure stays signed-in at the Firebase layer", () => {
    const loading = reduceAuth(initialAuthState, { type: "firebase_user" });
    const next = reduceAuth(loading, { type: "me_retryable", message: "network down" });
    expect(next.phase).toBe("error");
    expect(next.phase).not.toBe("unauthenticated");
    expect(reduceAuth(next, { type: "retry" }).phase).toBe("bootstrap_loading");
  });

  it("H — /api/me 401 becomes unauthenticated", () => {
    const loading = reduceAuth(initialAuthState, { type: "firebase_user" });
    expect(reduceAuth(loading, { type: "me_unauthenticated" }).phase).toBe("unauthenticated");
    expect(classifyMeError(new ApiError(401, "unauthenticated", "Invalid Firebase token"))).toEqual({
      type: "me_unauthenticated",
    });
  });

  it("I — /api/me 403 user_disabled becomes access denied", () => {
    const loading = reduceAuth(initialAuthState, { type: "firebase_user" });
    const next = reduceAuth(loading, { type: "me_denied", message: "This account is disabled" });
    expect(next.phase).toBe("denied");
    expect(
      classifyMeError(new ApiError(403, "user_disabled", "This account is disabled")),
    ).toEqual({ type: "me_denied", message: "This account is disabled" });
  });

  it("J — sign out clears application session", () => {
    expect(reduceAuth(ready(), { type: "sign_out" }).phase).toBe("unauthenticated");
    expect(reduceAuth(ready(), { type: "firebase_signed_out" }).userId).toBeNull();
  });

  it("does not unmount a ready session when Firebase emits the same user again", () => {
    expect(reduceAuth(ready(), { type: "firebase_user" }).phase).toBe("ready");
  });
});
