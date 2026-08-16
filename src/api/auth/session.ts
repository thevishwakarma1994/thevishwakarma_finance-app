import { createHash, randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { eq, lt } from "drizzle-orm";
import { sessions } from "../../db/schema.js";
import type { SqliteHandles } from "../../db/client.js";

export const SESSION_COOKIE = "sid";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(
  handles: SqliteHandles,
  workspaceId: string,
  days: number,
): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  const now = DateTime.utc();
  const expiresAt = now.plus({ days });
  handles.db
    .insert(sessions)
    .values({
      id: randomBytes(16).toString("hex"),
      tokenHash: hashToken(token),
      workspaceId,
      createdAt: now.toISO() ?? now.toUTC().toISO()!,
      expiresAt: expiresAt.toISO() ?? expiresAt.toUTC().toISO()!,
    })
    .run();
  return { token, expiresAt: expiresAt.toJSDate() };
}

export function readSession(
  handles: SqliteHandles,
  token: string,
): { workspaceId: string } | null {
  const row = handles.db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token)))
    .get();
  if (!row) return null;
  if (DateTime.fromISO(row.expiresAt, { zone: "utc" }) <= DateTime.utc()) {
    handles.db.delete(sessions).where(eq(sessions.id, row.id)).run();
    return null;
  }
  return { workspaceId: row.workspaceId };
}

export function deleteSession(handles: SqliteHandles, token: string): void {
  handles.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
}

export function purgeExpiredSessions(handles: SqliteHandles): void {
  handles.db
    .delete(sessions)
    .where(lt(sessions.expiresAt, DateTime.utc().toISO() ?? ""))
    .run();
}

export function cookieSecure(): boolean {
  return process.env.NODE_ENV === "production";
}
