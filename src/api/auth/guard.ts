import type { Context, Next } from "hono";
import { ZodError } from "zod";
import { DomainError } from "../../domain/ledger/types.js";
import type { DbHandles } from "../../db/client.js";
import { provisionUserWorkspace, type VerifiedIdentity } from "../../app/provisionUser.js";
import { timedPerf } from "../../perf/timing.js";

export type VerifyIdToken = (token: string) => Promise<VerifiedIdentity>;

type Env = {
  Variables: {
    workspaceId: string;
    userId: string;
    handles: DbHandles;
    verifyIdToken: VerifyIdToken;
  };
};

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token.trim() || null;
}

export async function requireFirebaseAuth(c: Context<Env>, next: Next) {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) {
    return c.json({ error: "unauthenticated", message: "Missing Firebase token" }, 401);
  }

  let identity: VerifiedIdentity;
  try {
    identity = await timedPerf("authMs", () => c.get("verifyIdToken")(token));
  } catch {
    return c.json({ error: "unauthenticated", message: "Invalid Firebase token" }, 401);
  }
  if (!identity.uid) {
    return c.json({ error: "unauthenticated", message: "Invalid Firebase token" }, 401);
  }

  try {
    const access = await timedPerf("provisionMs", () =>
      provisionUserWorkspace(c.get("handles"), identity),
    );
    c.set("workspaceId", access.workspaceId);
    c.set("userId", access.userId);
  } catch (error) {
    if (error instanceof DomainError && error.code === "user_disabled") {
      return c.json({ error: error.code, message: error.message }, 403);
    }
    throw error;
  }
  await next();
}

export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  const production = process.env.NODE_ENV === "production";
  if (!origin) {
    return !production;
  }
  const configured = process.env.APP_ORIGIN;
  if (configured && origin === configured) {
    return true;
  }
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) {
    return true;
  }
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export async function requireOrigin(c: Context, next: Next) {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
    await next();
    return;
  }
  const origin = c.req.header("origin");
  const host = c.req.header("host");
  if (!originAllowed(origin, host)) {
    return c.json({ error: "invalid_origin" }, 403);
  }
  await next();
}

export function mapError(
  error: unknown,
): { status: 400 | 403 | 404 | 409 | 500; body: { error: string; message: string } } {
  if (error instanceof DomainError) {
    const status =
      error.code === "user_disabled"
        ? 403
        : error.code === "insufficient_balance" ||
            error.code === "insufficient_available" ||
            error.code === "duplicate_category" ||
            error.code === "payment_exceeds_outstanding" ||
            error.code === "idempotency_conflict" ||
            error.code === "already_received" ||
            error.code === "duplicate_salary" ||
            error.code === "policy_version_in_use" ||
            error.code === "stale_correction_target" ||
            error.code === "correction_would_use_reserved_money"
          ? 409
          : error.code === "account_not_found" ||
              error.code === "category_not_found" ||
              error.code === "card_not_found" ||
              error.code === "cycle_not_found" ||
              error.code === "person_not_found" ||
              error.code === "claim_not_found" ||
              error.code === "surplus_not_found" ||
              error.code === "reservation_not_found" ||
              error.code === "obligation_not_found" ||
              error.code === "obligation_template_not_found"
            ? 404
            : 400;
    return { status, body: { error: error.code, message: error.message } };
  }
  if (error instanceof ZodError) {
    return { status: 400, body: { error: "invalid_input", message: error.message } };
  }
  return { status: 500, body: { error: "internal", message: "Something went wrong" } };
}
