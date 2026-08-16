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

export const creditCards = sqliteTable(
  "credit_cards",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    displayName: text("display_name").notNull(),
    issuer: text("issuer").notNull(),
    mask: text("mask"),
    creditLimitPaise: integer("credit_limit_paise"),
    defaultPaymentAccountId: text("default_payment_account_id").references(() => accounts.id),
    defaultOwnerPersonId: text("default_owner_person_id"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("credit_cards_workspace_status").on(table.workspaceId, table.status)],
);

export const configVersions = sqliteTable(
  "config_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    key: text("key").notNull(),
    subjectId: text("subject_id").notNull(),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
    value: text("value").notNull(),
  },
  (table) => [
    index("config_workspace_key_subject_from").on(
      table.workspaceId,
      table.key,
      table.subjectId,
      table.effectiveFrom,
    ),
  ],
);

export const billingCycles = sqliteTable(
  "billing_cycles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    creditCardId: text("credit_card_id")
      .notNull()
      .references(() => creditCards.id),
    purchaseWindowStart: text("purchase_window_start").notNull(),
    purchaseWindowEnd: text("purchase_window_end").notNull(),
    expectedStatementOn: text("expected_statement_on").notNull(),
    actualStatementOn: text("actual_statement_on"),
    expectedDueOn: text("expected_due_on").notNull(),
    actualDueOn: text("actual_due_on"),
    actualStatementAmountPaise: integer("actual_statement_amount_paise"),
    status: text("status").notNull(),
    ruleSnapshot: text("rule_snapshot").notNull(),
  },
  (table) => [
    uniqueIndex("billing_workspace_card_statement").on(
      table.workspaceId,
      table.creditCardId,
      table.expectedStatementOn,
    ),
    index("billing_cycles_workspace_card_status").on(table.workspaceId, table.creditCardId, table.status),
    index("billing_cycles_expected_due").on(table.expectedDueOn),
  ],
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
    creditCardId: text("credit_card_id").references(() => creditCards.id),
    billingCycleId: text("billing_cycle_id").references(() => billingCycles.id),
    obligationInstanceId: text("obligation_instance_id"),
    categoryId: text("category_id").references(() => categories.id),
    channel: text("channel"),
    merchant: text("merchant"),
    notes: text("notes"),
    reversalOfEventId: text("reversal_of_event_id"),
  },
  (table) => [
    index("events_workspace_occurred").on(table.workspaceId, table.occurredOn),
    index("events_workspace_meaning_occurred").on(table.workspaceId, table.meaning, table.occurredOn),
    index("events_card_cycle").on(table.creditCardId, table.billingCycleId),
    index("events_obligation_instance").on(table.obligationInstanceId),
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
    creditCardId: text("credit_card_id").references(() => creditCards.id),
    pnl: text("pnl"),
    categoryId: text("category_id").references(() => categories.id),
    billingCycleId: text("billing_cycle_id").references(() => billingCycles.id),
    claimId: text("claim_id"),
  },
  (table) => [
    index("postings_event").on(table.eventId),
    index("postings_account").on(table.accountId),
    index("postings_card_cycle").on(table.creditCardId, table.billingCycleId),
    index("postings_pnl_category").on(table.pnl, table.categoryId),
    index("postings_claim").on(table.claimId),
  ],
);

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    notes: text("notes"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("people_workspace_status").on(table.workspaceId, table.status)],
);

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    direction: text("direction").notNull(),
    kind: text("kind").notNull(),
    originalAmountPaise: integer("original_amount_paise").notNull(),
    originatingEventId: text("originating_event_id").references(() => financialEvents.id),
    openingPositionId: text("opening_position_id").references(() => openingPositions.id),
    billingCycleId: text("billing_cycle_id").references(() => billingCycles.id),
    obligationRefType: text("obligation_ref_type"),
    obligationRefId: text("obligation_ref_id"),
    note: text("note"),
    status: text("status").notNull(),
  },
  (table) => [
    index("claims_person_status").on(table.personId, table.status),
    index("claims_billing_cycle").on(table.billingCycleId),
    index("claims_originating_event").on(table.originatingEventId),
    index("claims_workspace").on(table.workspaceId),
  ],
);

export const eventShares = sqliteTable(
  "event_shares",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    eventId: text("event_id")
      .notNull()
      .references(() => financialEvents.id),
    personId: text("person_id").references(() => people.id),
    amountPaise: integer("amount_paise").notNull(),
    isUser: integer("is_user").notNull(),
  },
  (table) => [index("event_shares_event").on(table.eventId)],
);

export const settlementAllocations = sqliteTable(
  "settlement_allocations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    eventId: text("event_id")
      .notNull()
      .references(() => financialEvents.id),
    claimId: text("claim_id")
      .notNull()
      .references(() => claims.id),
    amountPaise: integer("amount_paise").notNull(),
    createsReservation: integer("creates_reservation").notNull(),
    reservationId: text("reservation_id"),
  },
  (table) => [
    uniqueIndex("settlement_event_claim").on(table.eventId, table.claimId),
    index("settlement_allocations_claim").on(table.claimId),
    index("settlement_allocations_workspace").on(table.workspaceId),
    index("settlement_allocations_reservation").on(table.reservationId),
  ],
);

export const reservations = sqliteTable(
  "reservations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    sourceAccountId: text("source_account_id")
      .notNull()
      .references(() => accounts.id),
    amountOriginalPaise: integer("amount_original_paise").notNull(),
    amountConsumedPaise: integer("amount_consumed_paise").notNull().default(0),
    amountReleasedPaise: integer("amount_released_paise").notNull().default(0),
    amountReassignedPaise: integer("amount_reassigned_paise").notNull().default(0),
    amountSurplusHeldPaise: integer("amount_surplus_held_paise").notNull().default(0),
    status: text("status").notNull(),
    obligationRefType: text("obligation_ref_type").notNull(),
    obligationRefId: text("obligation_ref_id").notNull(),
    originatingEventId: text("originating_event_id").references(() => financialEvents.id),
    originatingClaimId: text("originating_claim_id").references(() => claims.id),
    createdOn: text("created_on").notNull(),
  },
  (table) => [
    index("reservations_account_status").on(table.sourceAccountId, table.status),
    index("reservations_obligation").on(table.obligationRefType, table.obligationRefId),
    index("reservations_workspace").on(table.workspaceId),
  ],
);

export const reservationLedger = sqliteTable(
  "reservation_ledger",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => reservations.id),
    eventId: text("event_id")
      .notNull()
      .references(() => financialEvents.id),
    deltaConsumedPaise: integer("delta_consumed_paise").notNull().default(0),
    deltaReleasedPaise: integer("delta_released_paise").notNull().default(0),
    deltaReassignedPaise: integer("delta_reassigned_paise").notNull().default(0),
    deltaSurplusHeldPaise: integer("delta_surplus_held_paise").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("reservation_ledger_reservation_created").on(table.reservationId, table.createdAt),
    index("reservation_ledger_workspace").on(table.workspaceId),
  ],
);

export const surplusCases = sqliteTable(
  "surplus_cases",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    amountPaise: integer("amount_paise").notNull(),
    kind: text("kind").notNull(),
    sourceAccountId: text("source_account_id").references(() => accounts.id),
    personId: text("person_id").references(() => people.id),
    reservationId: text("reservation_id").references(() => reservations.id),
    eventId: text("event_id").references(() => financialEvents.id),
    explanation: text("explanation").notNull(),
    status: text("status").notNull(),
    resolution: text("resolution"),
    resolvedAt: text("resolved_at"),
    resolvedByEventId: text("resolved_by_event_id").references(() => financialEvents.id),
  },
  (table) => [
    index("surplus_cases_status").on(table.status),
    index("surplus_cases_person_status").on(table.personId, table.status),
    index("surplus_cases_workspace").on(table.workspaceId),
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

export const incomePolicies = sqliteTable(
  "income_policies",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    expectedAmountPaise: integer("expected_amount_paise").notNull(),
    windowStartDay: integer("window_start_day").notNull(),
    windowEndDay: integer("window_end_day").notNull(),
    typicalDay: integer("typical_day"),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
  },
  (table) => [index("income_policies_workspace_from").on(table.workspaceId, table.effectiveFrom)],
);

export const fundingCycles = sqliteTable(
  "funding_cycles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    expectedWindowStart: text("expected_window_start").notNull(),
    expectedWindowEnd: text("expected_window_end").notNull(),
    expectedAmountSnapshot: integer("expected_amount_snapshot").notNull(),
    actualArrivalOn: text("actual_arrival_on"),
    actualAmountPaise: integer("actual_amount_paise"),
    salaryEventId: text("salary_event_id").references(() => financialEvents.id),
  },
  (table) => [
    uniqueIndex("funding_cycles_workspace_year_month").on(table.workspaceId, table.year, table.month),
    index("funding_cycles_workspace_window").on(table.workspaceId, table.expectedWindowStart),
  ],
);

export const obligationTemplates = sqliteTable(
  "obligation_templates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    priority: text("priority").notNull(),
    dueRule: text("due_rule").notNull(),
    defaultAccountId: text("default_account_id").references(() => accounts.id),
    loanId: text("loan_id"),
    effectiveFrom: text("effective_from").notNull(),
    effectiveTo: text("effective_to"),
  },
  (table) => [index("obligation_templates_workspace_from").on(table.workspaceId, table.effectiveFrom, table.effectiveTo)],
);

export const obligationInstances = sqliteTable(
  "obligation_instances",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    templateId: text("template_id").references(() => obligationTemplates.id),
    nameSnapshot: text("name_snapshot").notNull(),
    dueOn: text("due_on").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    prioritySnapshot: text("priority_snapshot").notNull(),
    status: text("status").notNull(),
    fundingCycleId: text("funding_cycle_id").references(() => fundingCycles.id),
    paidEventId: text("paid_event_id").references(() => financialEvents.id),
  },
  (table) => [
    index("obligation_instances_workspace_due_status").on(table.workspaceId, table.dueOn, table.status),
    index("obligation_instances_funding_cycle").on(table.fundingCycleId),
  ],
);

export const schema = {
  workspaces,
  sessions,
  accounts,
  creditCards,
  configVersions,
  billingCycles,
  categories,
  financialEvents,
  postings,
  openingPositions,
  people,
  claims,
  eventShares,
  settlementAllocations,
  reservations,
  reservationLedger,
  surplusCases,
  incomePolicies,
  fundingCycles,
  obligationTemplates,
  obligationInstances,
};
