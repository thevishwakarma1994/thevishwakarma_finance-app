import { z } from "zod";
import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { DomainError } from "../domain/ledger/types.js";
import { formatInr } from "../domain/money/inr.js";
import { billingCycles } from "../db/schema.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import type { SqliteHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";

const inputSchema = z.object({
  cycleId: z.string().min(1),
  actualStatementAmountPaise: z.number().int().nonnegative(),
  actualStatementOn: z.string(),
  actualDueOn: z.string(),
});

export function confirmStatement(
  handles: SqliteHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const snapshot = loadSnapshot(handles, context.workspaceId, isoDate(input.actualStatementOn));
  const cycle = snapshot.billingCycles.find((item) => item.id === input.cycleId);
  if (!cycle) {
    throw new DomainError("cycle_not_found", "Billing cycle not found");
  }

  const actualAmount = paise(input.actualStatementAmountPaise);
  const mismatch = actualAmount !== cycle.expectedAmountPaise;

  handles.db
    .update(billingCycles)
    .set({
      actualStatementAmountPaise: actualAmount,
      actualStatementOn: isoDate(input.actualStatementOn),
      actualDueOn: isoDate(input.actualDueOn),
      status: "statement_confirmed",
    })
    .where(eq(billingCycles.id, cycle.id))
    .run();

  return {
    cycleId: cycle.id,
    expectedAmountPaise: cycle.expectedAmountPaise,
    actualStatementAmountPaise: actualAmount,
    mismatch,
    warning: mismatch
      ? `Statement mismatch: statement is ${formatInr(actualAmount)} vs tracked cycle activity ${formatInr(cycle.expectedAmountPaise)}`
      : null,
  };
}
