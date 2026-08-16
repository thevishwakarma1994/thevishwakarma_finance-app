import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { ZodError } from "zod";
import { DomainError } from "../../domain/ledger/types.js";
import type { SqliteHandles } from "../../db/client.js";
import { SESSION_COOKIE, readSession } from "./session.js";
import { readPasswordHashFromEnv, verifyPassword } from "./password.js";

type Env = {
  Variables: {
    workspaceId: string;
    handles: SqliteHandles;
  };
};

const loginAttempts = new Map<string, number[]>();

export function isPublicApi(method: string, path: string): boolean {
  return method === "POST" && path === "/api/login";
}

export function rateLimitLogin(key: string, windowMs = 10 * 60 * 1000, max = 8): boolean {
  const now = Date.now();
  const recent = (loginAttempts.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= max) {
    loginAttempts.set(key, recent);
    return false;
  }
  recent.push(now);
  loginAttempts.set(key, recent);
  return true;
}

export function clearLoginAttempts(key: string): void {
  loginAttempts.delete(key);
}

export function resetLoginAttempts(): void {
  loginAttempts.clear();
}

export async function requireSession(c: Context<Env>, next: Next) {
  if (isPublicApi(c.req.method, c.req.path)) {
    await next();
    return;
  }

  const handles = c.get("handles");
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const session = readSession(handles, token);
  if (!session) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("workspaceId", session.workspaceId);
  await next();
}

export function passwordFromEnv(): string {
  const hash = readPasswordHashFromEnv();
  if (!hash) {
    throw new Error("APP_PASSWORD_HASH is not set");
  }
  return hash;
}

export function checkPassword(password: string): boolean {
  return verifyPassword(password, passwordFromEnv());
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
): { status: 400 | 404 | 409 | 500; body: { error: string; message: string } } {
  if (error instanceof DomainError) {
    const status =
      error.code === "insufficient_balance" ||
      error.code === "duplicate_category" ||
      error.code === "payment_exceeds_outstanding"
        ? 409
        : error.code === "account_not_found" ||
            error.code === "category_not_found" ||
            error.code === "card_not_found" ||
            error.code === "cycle_not_found" ||
            error.code === "person_not_found"
          ? 404
          : 400;
    return { status, body: { error: error.code, message: error.message } };
  }
  if (error instanceof ZodError) {
    return { status: 400, body: { error: "invalid_input", message: error.message } };
  }
  return { status: 500, body: { error: "internal", message: "Something went wrong" } };
}
