import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { DomainError } from "../domain/ledger/types.js";
import { formatInr } from "../domain/money/inr.js";
import { payablePaise, statementRemaining } from "../domain/cycle/lifecycle.js";
import { parkCycleReservationExcess } from "../domain/reservations/parkExcess.js";
import { utcNowIso } from "../domain/calendar/kolkata.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistStatementConfirmation } from "../db/persistBatch.js";
import { anyDb, queryAll, queryGet, tables } from "../db/exec.js";
import { withCardThenAccountWriteLocks } from "../db/accountWriteLock.js";
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
  const plan = await statementLockPlan(handles, context.workspaceId, input.cycleId);
  return withCardThenAccountWriteLocks(
    handles,
    context.workspaceId,
    plan.creditCardId,
    plan.accountIds,
    async (tx) => {
      await assertWorkspaceOwned(tx, context.workspaceId, [{ type: "cycle", id: input.cycleId }]);
      const snapshot = await loadSnapshot(tx, context.workspaceId, isoDate(input.actualStatementOn));
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
        tx,
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
    },
  );
}

async function statementLockPlan(
  handles: DbHandles,
  workspaceId: string,
  cycleId: string,
): Promise<{ creditCardId: string; accountIds: string[] }> {
  const t = tables(handles);
  const cycle = await queryGet<{ workspaceId: string; creditCardId: string }>(
    handles,
    anyDb(handles)
      .select({
        workspaceId: t.billingCycles.workspaceId,
        creditCardId: t.billingCycles.creditCardId,
      })
      .from(t.billingCycles)
      .where(eq(t.billingCycles.id, cycleId)),
  );
  if (!cycle || cycle.workspaceId !== workspaceId) {
    throw new DomainError("cycle_not_found", "Billing cycle not found");
  }
  const reservations = await queryAll<{ sourceAccountId: string }>(
    handles,
    anyDb(handles)
      .select({ sourceAccountId: t.reservations.sourceAccountId })
      .from(t.reservations)
      .where(
        and(
          eq(t.reservations.workspaceId, workspaceId),
          eq(t.reservations.obligationRefType, "billing_cycle"),
          eq(t.reservations.obligationRefId, cycleId),
        ),
      ),
  );
  return {
    creditCardId: cycle.creditCardId,
    accountIds: reservations.map((row) => row.sourceAccountId),
  };
}
