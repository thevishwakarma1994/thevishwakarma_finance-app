import { useCallback, useEffect, useReducer, useRef } from "react";
import { ApiError, getMe, setUnauthorizedHandler } from "./apiClient.js";
import {
  completeGoogleRedirect,
  firebaseConfigured,
  signOutFirebase,
  subscribeAuth,
} from "./firebase.js";

export type AuthPhase =
  | "initializing"
  | "unauthenticated"
  | "bootstrap_loading"
  | "ready"
  | "denied"
  | "error";

export type AuthState = {
  phase: AuthPhase;
  userId: string | null;
  workspaceId: string | null;
  message: string | null;
};

export const initialAuthState: AuthState = {
  phase: "initializing",
  userId: null,
  workspaceId: null,
  message: null,
};

export type AuthEvent =
  | { type: "firebase_user" }
  | { type: "firebase_signed_out" }
  | { type: "me_success"; userId: string; workspaceId: string }
  | { type: "me_unauthenticated" }
  | { type: "me_denied"; message: string }
  | { type: "me_retryable"; message: string }
  | { type: "retry" }
  | { type: "sign_out" };

export function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "firebase_user":
      if (state.phase === "ready" || state.phase === "bootstrap_loading" || state.phase === "denied") {
        return state;
      }
      return { phase: "bootstrap_loading", userId: null, workspaceId: null, message: null };
    case "firebase_signed_out":
    case "sign_out":
    case "me_unauthenticated":
      return { phase: "unauthenticated", userId: null, workspaceId: null, message: null };
    case "me_success":
      return {
        phase: "ready",
        userId: event.userId,
        workspaceId: event.workspaceId,
        message: null,
      };
    case "me_denied":
      return { phase: "denied", userId: null, workspaceId: null, message: event.message };
    case "me_retryable":
      return {
        phase: "error",
        userId: state.userId,
        workspaceId: state.workspaceId,
        message: event.message,
      };
    case "retry":
      return {
        phase: "bootstrap_loading",
        userId: state.userId,
        workspaceId: state.workspaceId,
        message: null,
      };
    default: {
      const _never: never = event;
      return _never;
    }
  }
}

export function classifyMeError(error: unknown): Extract<
  AuthEvent,
  { type: "me_unauthenticated" | "me_denied" | "me_retryable" }
> {
  if (error instanceof ApiError && error.status === 401) {
    return { type: "me_unauthenticated" };
  }
  if (error instanceof ApiError && error.status === 403 && error.code === "user_disabled") {
    return { type: "me_denied", message: error.message || "This account is disabled" };
  }
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Could not reach the server";
  return { type: "me_retryable", message };
}

export function useAuthSession() {
  const [state, dispatch] = useReducer(reduceAuth, initialAuthState);
  const bootstrapId = useRef(0);
  const sessionLock = useRef<"open" | "ready" | "denied">("open");

  const runBootstrap = useCallback(async () => {
    const id = ++bootstrapId.current;
    try {
      const me = await getMe();
      if (id !== bootstrapId.current) return;
      if (!me.authenticated || !me.userId || !me.workspaceId) {
        sessionLock.current = "open";
        dispatch({ type: "me_unauthenticated" });
        return;
      }
      sessionLock.current = "ready";
      dispatch({ type: "me_success", userId: me.userId, workspaceId: me.workspaceId });
    } catch (error) {
      if (id !== bootstrapId.current) return;
      const classified = classifyMeError(error);
      if (classified.type === "me_denied") sessionLock.current = "denied";
      if (classified.type === "me_unauthenticated") sessionLock.current = "open";
      dispatch(classified);
    }
  }, []);

  const beginBootstrap = useCallback(() => {
    if (sessionLock.current === "ready" || sessionLock.current === "denied") {
      return;
    }
    dispatch({ type: "firebase_user" });
    void runBootstrap();
  }, [runBootstrap]);

  useEffect(() => {
    if (!firebaseConfigured()) {
      dispatch({ type: "firebase_signed_out" });
      return;
    }

    const unsubscribe = subscribeAuth((user) => {
      if (!user) {
        bootstrapId.current += 1;
        sessionLock.current = "open";
        dispatch({ type: "firebase_signed_out" });
        return;
      }
      beginBootstrap();
    });

    void completeGoogleRedirect().catch(() => null);

    return () => {
      unsubscribe();
    };
  }, [beginBootstrap]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (sessionLock.current === "ready") {
        sessionLock.current = "open";
        dispatch({ type: "me_unauthenticated" });
      }
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const retry = useCallback(() => {
    sessionLock.current = "open";
    dispatch({ type: "retry" });
    void runBootstrap();
  }, [runBootstrap]);

  const signOut = useCallback(async () => {
    bootstrapId.current += 1;
    sessionLock.current = "open";
    try {
      await signOutFirebase();
    } finally {
      dispatch({ type: "sign_out" });
    }
  }, []);

  return { state, beginBootstrap, retry, signOut };
}
