import { eq } from "drizzle-orm";
import { newId } from "../domain/ids.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles, SqliteHandles } from "./handles.js";
import { anyDb, queryAll, queryGet, queryRun, tables } from "./exec.js"; 
import { withPostgresTransaction, withSqliteTransaction } from "./tx.js";

export type MembershipRole = "owner";

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

type UserRow = {
  id: string;
  firebaseUid: string;
  displayName: string | null;
  primaryEmail: string | null;
  status: string;
};

type MembershipRow = {
  userId: string;
  workspaceId: string;
  role: string;
  createdAt: string;
};

async function personalWorkspaceForUser(
  handles: DbHandles,
  userId: string,
): Promise<ProvisionedAccess | null> {
  const t = tables(handles);
  const memberships = await queryAll<MembershipRow>(
    handles,
    anyDb(handles).select().from(t.workspaceMemberships).where(eq(t.workspaceMemberships.userId, userId)),
  );
  const membership = memberships.sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!membership) return null;
  return {
    userId,
    workspaceId: membership.workspaceId,
    role: membership.role as MembershipRole,
  };
}

function personalWorkspaceForUserSqlite(handles: SqliteHandles, userId: string): ProvisionedAccess | null {
  const t = tables(handles);
  const membership = handles.db
    .select()
    .from(t.workspaceMemberships)
    .where(eq(t.workspaceMemberships.userId, userId))
    .all()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
  if (!membership) return null;
  return {
    userId,
    workspaceId: membership.workspaceId,
    role: membership.role as MembershipRole,
  };
}

function createPersonalWorkspaceSqlite(handles: SqliteHandles, userId: string): ProvisionedAccess {
  const existing = personalWorkspaceForUserSqlite(handles, userId);
  if (existing) return existing;
  const now = utcNowIso();
  const workspaceId = newId();
  const t = tables(handles);
  handles.db
    .insert(t.workspaces)
    .values({
      id: workspaceId,
      name: "Personal",
      createdAt: now,
    })
    .run();
  handles.db
    .insert(t.workspaceMemberships)
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

async function createPersonalWorkspace(handles: DbHandles, userId: string): Promise<ProvisionedAccess> {
  const existing = await personalWorkspaceForUser(handles, userId);
  if (existing) return existing;
  const now = utcNowIso();
  const workspaceId = newId();
  const t = tables(handles);
  await queryRun(
    handles,
    anyDb(handles).insert(t.workspaces).values({
      id: workspaceId,
      name: "Personal",
      createdAt: now,
    }),
  );
  await queryRun(
    handles,
    anyDb(handles).insert(t.workspaceMemberships).values({
      id: newId(),
      userId,
      workspaceId,
      role: "owner",
      createdAt: now,
    }),
  );
  return { userId, workspaceId, role: "owner" };
}

/**
 * Firebase uid → internal user → membership → workspace.
 * Email is metadata only and never used for authorization.
 */
export async function provisionUserWorkspace(
  handles: DbHandles,
  identity: VerifiedIdentity,
): Promise<ProvisionedAccess> {
  const t = tables(handles);
  const existing = await queryGet<UserRow>(
    handles,
    anyDb(handles).select().from(t.users).where(eq(t.users.firebaseUid, identity.uid)),
  );
  if (existing) {
    if (existing.status !== "active") {
      throw new DomainError("user_disabled", "This account is disabled");
    }
    const now = utcNowIso();
    await queryRun(
      handles,
      anyDb(handles)
        .update(t.users)
        .set({
          displayName: identity.displayName ?? existing.displayName,
          primaryEmail: identity.email ?? existing.primaryEmail,
          updatedAt: now,
        })
        .where(eq(t.users.id, existing.id)),
    );
    const access = await personalWorkspaceForUser(handles, existing.id);
    if (access) return access;
    if (handles.dialect === "sqlite") {
      return createPersonalWorkspaceSqlite(handles, existing.id);
    }
    return createPersonalWorkspace(handles, existing.id);
  }

  if (handles.dialect === "sqlite") {
    return withSqliteTransaction(handles, () => {
      const raced = anyDb(handles).select().from(t.users).where(eq(t.users.firebaseUid, identity.uid)).get();
      if (raced) {
        if (raced.status !== "active") {
          throw new DomainError("user_disabled", "This account is disabled");
        }
        const access = personalWorkspaceForUserSqlite(handles, raced.id);
        if (access) return access;
        return createPersonalWorkspaceSqlite(handles, raced.id);
      }
      const now = utcNowIso();
      const userId = newId();
      handles.db
        .insert(t.users)
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
      return createPersonalWorkspaceSqlite(handles, userId);
    });
  }

  return withPostgresTransaction(handles, async (tx) => {
    const txTables = tables(tx);
    const raced = await queryGet<UserRow>(
      tx,
      anyDb(tx).select().from(txTables.users).where(eq(txTables.users.firebaseUid, identity.uid)),
    );
    if (raced) {
      if (raced.status !== "active") {
        throw new DomainError("user_disabled", "This account is disabled");
      }
      const access = await personalWorkspaceForUser(tx, raced.id);
      if (access) return access;
      return createPersonalWorkspace(tx, raced.id);
    }
    const now = utcNowIso();
    const userId = newId();
    await anyDb(tx).insert(txTables.users).values({
      id: userId,
      firebaseUid: identity.uid,
      displayName: identity.displayName,
      primaryEmail: identity.email,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return createPersonalWorkspace(tx, userId);
  });
}
