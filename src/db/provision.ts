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

type ExistingAccessRow = {
  userId: string;
  status: string;
  displayName: string | null;
  primaryEmail: string | null;
  workspaceId: string | null;
  role: string | null;
  membershipCreatedAt: string | null;
};

/**
 * Hot path for returning users: one joined lookup
 * firebase_uid → user + earliest personal membership.
 */
async function lookupExistingAccess(
  handles: DbHandles,
  firebaseUid: string,
): Promise<ExistingAccessRow | null> {
  const t = tables(handles);
  const rows = await queryAll<ExistingAccessRow>(
    handles,
    anyDb(handles)
      .select({
        userId: t.users.id,
        status: t.users.status,
        displayName: t.users.displayName,
        primaryEmail: t.users.primaryEmail,
        workspaceId: t.workspaceMemberships.workspaceId,
        role: t.workspaceMemberships.role,
        membershipCreatedAt: t.workspaceMemberships.createdAt,
      })
      .from(t.users)
      .leftJoin(t.workspaceMemberships, eq(t.workspaceMemberships.userId, t.users.id))
      .where(eq(t.users.firebaseUid, firebaseUid)),
  );
  if (rows.length === 0) return null;
  const withMembership = rows
    .filter((row) => row.workspaceId)
    .sort((left, right) =>
      (left.membershipCreatedAt ?? "").localeCompare(right.membershipCreatedAt ?? ""),
    );
  return withMembership[0] ?? rows[0] ?? null;
}

function lookupExistingAccessSqlite(
  handles: SqliteHandles,
  firebaseUid: string,
): ExistingAccessRow | null {
  const t = tables(handles);
  const rows = anyDb(handles)
    .select({
      userId: t.users.id,
      status: t.users.status,
      displayName: t.users.displayName,
      primaryEmail: t.users.primaryEmail,
      workspaceId: t.workspaceMemberships.workspaceId,
      role: t.workspaceMemberships.role,
      membershipCreatedAt: t.workspaceMemberships.createdAt,
    })
    .from(t.users)
    .leftJoin(t.workspaceMemberships, eq(t.workspaceMemberships.userId, t.users.id))
    .where(eq(t.users.firebaseUid, firebaseUid))
    .all() as ExistingAccessRow[];
  if (rows.length === 0) return null;
  const withMembership = rows
    .filter((row) => row.workspaceId)
    .sort((left, right) =>
      (left.membershipCreatedAt ?? "").localeCompare(right.membershipCreatedAt ?? ""),
    );
  return withMembership[0] ?? rows[0] ?? null;
}

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

function metadataChanged(
  existing: { displayName: string | null; primaryEmail: string | null },
  identity: VerifiedIdentity,
): boolean {
  const nextName = identity.displayName ?? existing.displayName;
  const nextEmail = identity.email ?? existing.primaryEmail;
  return nextName !== existing.displayName || nextEmail !== existing.primaryEmail;
}

/**
 * Firebase uid → internal user → membership → workspace.
 * Email is metadata only and never used for authorization.
 * Existing users with a membership use one joined lookup (no write on the hot path
 * when display metadata is unchanged).
 */
export async function provisionUserWorkspace(
  handles: DbHandles,
  identity: VerifiedIdentity,
): Promise<ProvisionedAccess> {
  const t = tables(handles);

  const existing =
    handles.dialect === "sqlite"
      ? lookupExistingAccessSqlite(handles, identity.uid)
      : await lookupExistingAccess(handles, identity.uid);

  if (existing) {
    if (existing.status !== "active") {
      throw new DomainError("user_disabled", "This account is disabled");
    }
    if (metadataChanged(existing, identity)) {
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
          .where(eq(t.users.id, existing.userId)),
      );
    }
    if (existing.workspaceId && existing.role) {
      return {
        userId: existing.userId,
        workspaceId: existing.workspaceId,
        role: existing.role as MembershipRole,
      };
    }
    if (handles.dialect === "sqlite") {
      return createPersonalWorkspaceSqlite(handles, existing.userId);
    }
    return createPersonalWorkspace(handles, existing.userId);
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
