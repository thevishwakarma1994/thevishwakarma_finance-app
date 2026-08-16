import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { SqliteHandles } from "../../db/client.js";
import { getSoleWorkspaceId } from "../../db/migrate.js";
import { checkPassword, clearLoginAttempts, rateLimitLogin } from "./guard.js";
import {
  SESSION_COOKIE,
  cookieSecure,
  createSession,
  deleteSession,
} from "./session.js";

type Env = {
  Variables: { handles: SqliteHandles; workspaceId: string };
};

export const authRoutes = new Hono<Env>();

authRoutes.post("/login", async (c) => {
  const handles = c.get("handles");
  const ip = c.req.header("x-forwarded-for") ?? "local";
  if (!rateLimitLogin(ip)) {
    return c.json({ error: "rate_limited", message: "Too many sign-in attempts" }, 429);
  }

  const body = (await c.req.json().catch(() => null)) as { password?: string } | null;
  const password = body?.password ?? "";
  if (!checkPassword(password)) {
    return c.json({ error: "invalid_credentials", message: "Wrong password" }, 401);
  }

  clearLoginAttempts(ip);
  const days = Number(process.env.SESSION_DAYS ?? 7);
  const workspaceId = getSoleWorkspaceId(handles);
  const { token, expiresAt } = createSession(handles, workspaceId, days);
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(),
    expires: expiresAt,
  });
  return c.json({ ok: true });
});

authRoutes.post("/logout", (c) => {
  const handles = c.get("handles");
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    deleteSession(handles, token);
  }
  deleteCookie(c, SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(),
  });
  return c.json({ ok: true });
});

authRoutes.get("/me", (c) => {
  return c.json({ authenticated: true });
});
