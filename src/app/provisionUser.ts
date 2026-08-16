import { eq } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import { users, workspaceMemberships, workspaces } from "../db/schema.js";
import type { SqliteHandles } from "../db/client.js";
import { withTransaction } from "../db/tx.js";

export const MEMBERSHIP_ROLES = ["owner"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export type VerifiedIdentity = {
  uid: string;
  email: string | null;
  displayName: string | null;
};

export type ProvisionedAccess = {
  userId: string;
  workspaceId: string;
  role: MembershipRole;
};

function personalWorkspaceForUser(handles: SqliteHandles, userId: string): ProvisionedAccess | null {
  const membership = handles.db
    .select()
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, userId))
    .all()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!membership) return null;
  return {
    userId,
    workspaceId: membership.workspaceId,
    role: membership.role as MembershipRole,
  };
}

export function provisionUserWorkspace(
  handles: SqliteHandles,
  identity: VerifiedIdentity,
): ProvisionedAccess {
  // uid is the only authorization key. email/displayName are verified-token metadata.
  const existing = handles.db.select().from(users).where(eq(users.firebaseUid, identity.uid)).get();
  if (existing) {
    if (existing.status !== "active") {
      throw new DomainError("user_disabled", "This account is disabled");
    }
    const now = utcNowIso();
    handles.db
      .update(users)
      .set({
        displayName: identity.displayName ?? existing.displayName,
        primaryEmail: identity.email ?? existing.primaryEmail,
        updatedAt: now,
      })
      .where(eq(users.id, existing.id))
      .run();
    const access = personalWorkspaceForUser(handles, existing.id);
    if (access) return access;
    return createPersonalWorkspace(handles, existing.id);
  }

  return withTransaction(handles, () => {
    const raced = handles.db.select().from(users).where(eq(users.firebaseUid, identity.uid)).get();
    if (raced) {
      if (raced.status !== "active") {
        throw new DomainError("user_disabled", "This account is disabled");
      }
      const access = personalWorkspaceForUser(handles, raced.id);
      if (access) return access;
      return createPersonalWorkspace(handles, raced.id);
    }
    const now = utcNowIso();
    const userId = newId();
    handles.db
      .insert(users)
      .values({
        id: userId,
        firebaseUid: identity.uid,
        displayName: identity.displayName,
        primaryEmail: identity.email,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return createPersonalWorkspace(handles, userId);
  });
}

function createPersonalWorkspace(handles: SqliteHandles, userId: string): ProvisionedAccess {
  const existing = personalWorkspaceForUser(handles, userId);
  if (existing) return existing;
  const now = utcNowIso();
  const workspaceId = newId();
  handles.db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: "Personal",
      createdAt: now,
    })
    .run();
  handles.db
    .insert(workspaceMemberships)
    .values({
      id: newId(),
      userId,
      workspaceId,
      role: "owner",
      createdAt: now,
    })
    .run();
  return { userId, workspaceId, role: "owner" };
}
