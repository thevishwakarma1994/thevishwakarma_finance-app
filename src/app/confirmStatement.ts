import { z } from "zod";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { DomainError } from "../domain/ledger/types.js";
import { formatInr } from "../domain/money/inr.js";
import { payablePaise, statementRemaining } from "../domain/cycle/lifecycle.js";
import { parkCycleReservationExcess } from "../domain/reservations/parkExcess.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistStatementConfirmation } from "../db/persistBatch.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";

const inputSchema = z.object({
  cycleId: z.string().min(1),
  actualStatementAmountPaise: z.number().int().nonnegative(),
  actualStatementOn: z.string(),
  actualDueOn: z.string(),
});

export async function confirmStatement(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  await assertWorkspaceOwned(handles, context.workspaceId, [{ type: "cycle", id: input.cycleId }]);
  const snapshot = await loadSnapshot(handles, context.workspaceId, isoDate(input.actualStatementOn));
  const cycle = snapshot.billingCycles.find((item) => item.id === input.cycleId);
  if (!cycle) {
    throw new DomainError("cycle_not_found", "Billing cycle not found");
  }

  const actualAmount = paise(input.actualStatementAmountPaise);
  const mismatch = actualAmount !== cycle.expectedAmountPaise;
  const remainingAfter = payablePaise(
    cycle.ledgerRemainingPaise,
    statementRemaining(actualAmount, cycle.expectedAmountPaise, cycle.amountPaidPaise),
  );
  const excessBatch = parkCycleReservationExcess(
    snapshot,
    cycle.id,
    remainingAfter,
    utcNowIso(),
  );

  await persistStatementConfirmation(
    handles,
    context.workspaceId,
    {
      cycleId: cycle.id,
      actualStatementAmountPaise: actualAmount,
      actualStatementOn: isoDate(input.actualStatementOn),
      actualDueOn: isoDate(input.actualDueOn),
    },
    {
      events: [],
      postings: [],
      openings: [],
      ...excessBatch,
    },
  );

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
