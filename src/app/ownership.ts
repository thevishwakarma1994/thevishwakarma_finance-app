import { eq } from "drizzle-orm";
import { DomainError } from "../domain/ledger/types.js";
import {
  accounts,
  billingCycles,
  categories,
  claims,
  creditCards,
  obligationInstances,
  obligationTemplates,
  people,
  reservations,
  surplusCases,
} from "../db/schema.js";
import type { SqliteHandles } from "../db/client.js";

export type WorkspaceRef =
  | { type: "account"; id: string }
  | { type: "card"; id: string }
  | { type: "person"; id: string }
  | { type: "claim"; id: string }
  | { type: "cycle"; id: string }
  | { type: "obligation"; id: string }
  | { type: "category"; id: string }
  | { type: "reservation"; id: string }
  | { type: "surplus"; id: string }
  | { type: "template"; id: string };

function owned(
  row: { workspaceId: string } | undefined,
  workspaceId: string,
  code: string,
  message: string,
): void {
  if (!row || row.workspaceId !== workspaceId) {
    throw new DomainError(code, message);
  }
}

export function assertAccountInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(accounts).where(eq(accounts.id, id)).get(),
    workspaceId,
    "account_not_found",
    "Account not found",
  );
}

export function assertCardInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(creditCards).where(eq(creditCards.id, id)).get(),
    workspaceId,
    "card_not_found",
    "Credit card not found",
  );
}

export function assertPersonInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(people).where(eq(people.id, id)).get(),
    workspaceId,
    "person_not_found",
    "Person not found",
  );
}

export function assertClaimInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(claims).where(eq(claims.id, id)).get(),
    workspaceId,
    "claim_not_found",
    "Claim not found",
  );
}

export function assertCycleInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(billingCycles).where(eq(billingCycles.id, id)).get(),
    workspaceId,
    "cycle_not_found",
    "Billing cycle not found",
  );
}

export function assertObligationInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(obligationInstances).where(eq(obligationInstances.id, id)).get(),
    workspaceId,
    "obligation_not_found",
    "Obligation not found",
  );
}

export function assertCategoryInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(categories).where(eq(categories.id, id)).get(),
    workspaceId,
    "category_not_found",
    "Category not found",
  );
}

export function assertReservationInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(reservations).where(eq(reservations.id, id)).get(),
    workspaceId,
    "reservation_not_found",
    "Reservation not found",
  );
}

export function assertSurplusInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(surplusCases).where(eq(surplusCases.id, id)).get(),
    workspaceId,
    "surplus_not_found",
    "Surplus case not found",
  );
}

export function assertTemplateInWorkspace(handles: SqliteHandles, workspaceId: string, id: string) {
  owned(
    handles.db.select().from(obligationTemplates).where(eq(obligationTemplates.id, id)).get(),
    workspaceId,
    "obligation_template_not_found",
    "Obligation template not found",
  );
}

/** Reject IDs that do not belong to the authenticated workspace before persistence. */
export function assertWorkspaceOwned(
  handles: SqliteHandles,
  workspaceId: string,
  refs: Array<WorkspaceRef | null | undefined>,
): void {
  for (const ref of refs) {
    if (!ref) continue;
    switch (ref.type) {
      case "account":
        assertAccountInWorkspace(handles, workspaceId, ref.id);
        break;
      case "card":
        assertCardInWorkspace(handles, workspaceId, ref.id);
        break;
      case "person":
        assertPersonInWorkspace(handles, workspaceId, ref.id);
        break;
      case "claim":
        assertClaimInWorkspace(handles, workspaceId, ref.id);
        break;
      case "cycle":
        assertCycleInWorkspace(handles, workspaceId, ref.id);
        break;
      case "obligation":
        assertObligationInWorkspace(handles, workspaceId, ref.id);
        break;
      case "category":
        assertCategoryInWorkspace(handles, workspaceId, ref.id);
        break;
      case "reservation":
        assertReservationInWorkspace(handles, workspaceId, ref.id);
        break;
      case "surplus":
        assertSurplusInWorkspace(handles, workspaceId, ref.id);
        break;
      case "template":
        assertTemplateInWorkspace(handles, workspaceId, ref.id);
        break;
      default: {
        const _never: never = ref;
        return _never;
      }
    }
  }
}
