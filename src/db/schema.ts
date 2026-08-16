import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    kind: text("kind").notNull(),
    displayName: text("display_name").notNull(),
    mask: text("mask"),
    isPrimarySalary: integer("is_primary_salary").notNull().default(0),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("accounts_workspace_kind_status").on(table.workspaceId, table.kind, table.status)],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    parentId: text("parent_id"),
    name: text("name").notNull(),
    archivedAt: text("archived_at"),
  },
  (table) => [index("categories_workspace_parent").on(table.workspaceId, table.parentId)],
);

export const financialEvents = sqliteTable(
  "financial_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    meaning: text("meaning").notNull(),
    occurredOn: text("occurred_on").notNull(),
    capturedAt: text("captured_at").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    accountId: text("account_id").references(() => accounts.id),
    categoryId: text("category_id").references(() => categories.id),
    channel: text("channel"),
    merchant: text("merchant"),
    notes: text("notes"),
    reversalOfEventId: text("reversal_of_event_id"),
  },
  (table) => [
    index("events_workspace_occurred").on(table.workspaceId, table.occurredOn),
    index("events_workspace_meaning_occurred").on(table.workspaceId, table.meaning, table.occurredOn),
  ],
);

export const postings = sqliteTable(
  "postings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    eventId: text("event_id")
      .notNull()
      .references(() => financialEvents.id),
    amountPaise: integer("amount_paise").notNull(),
    accountId: text("account_id").references(() => accounts.id),
    pnl: text("pnl"),
    categoryId: text("category_id").references(() => categories.id),
  },
  (table) => [
    index("postings_event").on(table.eventId),
    index("postings_account").on(table.accountId),
    index("postings_pnl_category").on(table.pnl, table.categoryId),
  ],
);

export const openingPositions = sqliteTable(
  "opening_positions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    effectiveOn: text("effective_on").notNull(),
    kind: text("kind").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: text("payload").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("opening_workspace_kind_subject").on(table.workspaceId, table.kind, table.subjectId),
  ],
);

export const schema = {
  workspaces,
  sessions,
  accounts,
  categories,
  financialEvents,
  postings,
  openingPositions,
};
