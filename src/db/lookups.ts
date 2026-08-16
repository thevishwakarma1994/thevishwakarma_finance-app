import { eq } from "drizzle-orm";
import type { DbHandles } from "./handles.js";
import { anyDb, queryGet, tables } from "./exec.js"; 

type Scoped = { workspaceId: string; id: string };

export async function findWorkspaceScoped(
  handles: DbHandles,
  table:
    | "accounts"
    | "creditCards"
    | "people"
    | "claims"
    | "billingCycles"
    | "obligationInstances"
    | "categories"
    | "reservations"
    | "surplusCases"
    | "obligationTemplates",
  id: string,
): Promise<Scoped | undefined> {
  const t = tables(handles);
  switch (table) {
    case "accounts":
      return queryGet(handles, anyDb(handles).select().from(t.accounts).where(eq(t.accounts.id, id)));
    case "creditCards":
      return queryGet(handles, anyDb(handles).select().from(t.creditCards).where(eq(t.creditCards.id, id)));
    case "people":
      return queryGet(handles, anyDb(handles).select().from(t.people).where(eq(t.people.id, id)));
    case "claims":
      return queryGet(handles, anyDb(handles).select().from(t.claims).where(eq(t.claims.id, id)));
    case "billingCycles":
      return queryGet(handles, anyDb(handles).select().from(t.billingCycles).where(eq(t.billingCycles.id, id)));
    case "obligationInstances":
      return queryGet(
        handles,
        anyDb(handles).select().from(t.obligationInstances).where(eq(t.obligationInstances.id, id)),
      );
    case "categories":
      return queryGet(handles, anyDb(handles).select().from(t.categories).where(eq(t.categories.id, id)));
    case "reservations":
      return queryGet(handles, anyDb(handles).select().from(t.reservations).where(eq(t.reservations.id, id)));
    case "surplusCases":
      return queryGet(handles, anyDb(handles).select().from(t.surplusCases).where(eq(t.surplusCases.id, id)));
    case "obligationTemplates":
      return queryGet(
        handles,
        anyDb(handles).select().from(t.obligationTemplates).where(eq(t.obligationTemplates.id, id)),
      );
    default: {
      const _never: never = table;
      return _never;
    }
  }
}
