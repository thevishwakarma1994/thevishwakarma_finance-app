import { DomainError } from "../domain/ledger/types.js";
import type { DbHandles } from "../db/client.js";
import { findWorkspaceScoped } from "../db/lookups.js";

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

export async function assertAccountInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(await findWorkspaceScoped(handles, "accounts", id), workspaceId, "account_not_found", "Account not found");
}

export async function assertCardInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(await findWorkspaceScoped(handles, "creditCards", id), workspaceId, "card_not_found", "Credit card not found");
}

export async function assertPersonInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(await findWorkspaceScoped(handles, "people", id), workspaceId, "person_not_found", "Person not found");
}

export async function assertClaimInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(await findWorkspaceScoped(handles, "claims", id), workspaceId, "claim_not_found", "Claim not found");
}

export async function assertCycleInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(await findWorkspaceScoped(handles, "billingCycles", id), workspaceId, "cycle_not_found", "Billing cycle not found");
}

export async function assertObligationInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(
    await findWorkspaceScoped(handles, "obligationInstances", id),
    workspaceId,
    "obligation_not_found",
    "Obligation not found",
  );
}

export async function assertCategoryInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(await findWorkspaceScoped(handles, "categories", id), workspaceId, "category_not_found", "Category not found");
}

export async function assertReservationInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(
    await findWorkspaceScoped(handles, "reservations", id),
    workspaceId,
    "reservation_not_found",
    "Reservation not found",
  );
}

export async function assertSurplusInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(await findWorkspaceScoped(handles, "surplusCases", id), workspaceId, "surplus_not_found", "Surplus case not found");
}

export async function assertTemplateInWorkspace(handles: DbHandles, workspaceId: string, id: string) {
  owned(
    await findWorkspaceScoped(handles, "obligationTemplates", id),
    workspaceId,
    "obligation_template_not_found",
    "Obligation template not found",
  );
}

/** Reject IDs that do not belong to the authenticated workspace before persistence. */
export async function assertWorkspaceOwned(
  handles: DbHandles,
  workspaceId: string,
  refs: Array<WorkspaceRef | null | undefined>,
): Promise<void> {
  for (const ref of refs) {
    if (!ref) continue;
    switch (ref.type) {
      case "account":
        await assertAccountInWorkspace(handles, workspaceId, ref.id);
        break;
      case "card":
        await assertCardInWorkspace(handles, workspaceId, ref.id);
        break;
      case "person":
        await assertPersonInWorkspace(handles, workspaceId, ref.id);
        break;
      case "claim":
        await assertClaimInWorkspace(handles, workspaceId, ref.id);
        break;
      case "cycle":
        await assertCycleInWorkspace(handles, workspaceId, ref.id);
        break;
      case "obligation":
        await assertObligationInWorkspace(handles, workspaceId, ref.id);
        break;
      case "category":
        await assertCategoryInWorkspace(handles, workspaceId, ref.id);
        break;
      case "reservation":
        await assertReservationInWorkspace(handles, workspaceId, ref.id);
        break;
      case "surplus":
        await assertSurplusInWorkspace(handles, workspaceId, ref.id);
        break;
      case "template":
        await assertTemplateInWorkspace(handles, workspaceId, ref.id);
        break;
      default: {
        const _never: never = ref;
        return _never;
      }
    }
  }
}
