import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { todayKolkata } from "../domain/calendar/kolkata.js";
import { simulateAffordability as simulateAffordabilityDomain } from "../domain/engine/simulateAffordability.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  amountPaise: z.number().int().positive(),
  occurredOn: z.string().optional(),
  funding: z.union([
    z.object({ accountId: z.string().min(1) }),
    z.object({ creditCardId: z.string().min(1) }),
  ]),
  categoryId: z.string().min(1).optional(),
});

export function simulateAffordability(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  assertWorkspaceOwned(handles, context.workspaceId, [
    "accountId" in input.funding
      ? { type: "account" as const, id: input.funding.accountId }
      : { type: "card" as const, id: input.funding.creditCardId },
    input.categoryId ? { type: "category" as const, id: input.categoryId } : null,
  ]);
  const occurredOn = isoDate(input.occurredOn ?? todayKolkata());
  const snapshot = loadSnapshot(handles, context.workspaceId, occurredOn);
  const meaning = "accountId" in input.funding ? "spend_account" : "spend_card";
  return simulateAffordabilityDomain(snapshot, occurredOn, {
    amountPaise: paise(input.amountPaise),
    occurredOn,
    funding: input.funding,
    categoryId: input.categoryId,
    meaning,
  });
}
