import { z } from "zod";
import { eq } from "drizzle-orm";
import { isoDate } from "../domain/calendar/isoDate.js";
import { paise } from "../domain/money/paise.js";
import { todayKolkata, utcNowIso } from "../domain/calendar/kolkata.js";
import { resolveSurplus as resolveSurplusDomain } from "../domain/commands/resolveSurplus.js";
import { loadSnapshot } from "../db/loadSnapshot.js";
import { persistBatch } from "../db/persistBatch.js";
import { anyDb, queryGet, tables } from "../db/exec.js";
import { withOptionalCardThenAccountWriteLocks } from "../db/accountWriteLock.js";
import type { DbHandles } from "../db/client.js";
import type { WorkspaceContext } from "./context.js";
import { assertWorkspaceOwned } from "./ownership.js";
import { DomainError } from "../domain/ledger/types.js";

const inputSchema = z.object({
  surplusCaseId: z.string().min(1),
  resolution: z.enum([
    "apply_to_other_claim",
    "convert_to_payable",
    "treat_as_mine_correction",
    "reassign_reservation",
  ]),
  amountPaise: z.number().int().positive().optional(),
  claimId: z.string().min(1).optional(),
  billingCycleId: z.string().min(1).optional(),
  confirmed: z.boolean().optional(),
  occurredOn: z.string().optional(),
  capturedAt: z.string().optional(),
  commit: z.boolean().default(true),
});

type SurplusInput = z.infer<typeof inputSchema>;

export async function resolveSurplus(
  handles: DbHandles,
  context: WorkspaceContext,
  raw: unknown,
) {
  const input = inputSchema.parse(raw);
  const run = async (tx: DbHandles) => {
    await assertWorkspaceOwned(tx, context.workspaceId, [
      { type: "surplus", id: input.surplusCaseId },
      input.claimId ? { type: "claim" as const, id: input.claimId } : null,
      input.billingCycleId ? { type: "cycle" as const, id: input.billingCycleId } : null,
    ]);
    const occurredOn = isoDate(input.occurredOn ?? todayKolkata());
    const snapshot = await loadSnapshot(tx, context.workspaceId, occurredOn);
    const result = resolveSurplusDomain(
      {
        occurredOn,
        capturedAt: input.capturedAt ?? utcNowIso(),
        surplusCaseId: input.surplusCaseId,
        resolution: input.resolution,
        amountPaise: input.amountPaise === undefined ? undefined : paise(input.amountPaise),
        claimId: input.claimId,
        billingCycleId: input.billingCycleId,
        confirmed: input.confirmed,
      },
      snapshot,
    );

    if (input.commit) {
      await persistBatch(tx, context.workspaceId, result.batch);
    }

    return {
      preview: result.preview,
      eventId: result.batch.events[0]?.id ?? null,
      committed: input.commit,
    };
  };

  if (!input.commit) {
    return run(handles);
  }
  const plan = await surplusLockPlan(handles, context.workspaceId, input);
  return withOptionalCardThenAccountWriteLocks(
    handles,
    context.workspaceId,
    plan.creditCardId,
    plan.accountIds,
    run,
  );
}

async function cycleCreditCardId(
  handles: DbHandles,
  workspaceId: string,
  cycleId: string,
): Promise<string | null> {
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
  if (!cycle || cycle.workspaceId !== workspaceId) return null;
  return cycle.creditCardId;
}

async function surplusLockPlan(
  handles: DbHandles,
  workspaceId: string,
  input: SurplusInput,
): Promise<{ creditCardId: string | null; accountIds: string[] }> {
  const t = tables(handles);
  const surplus = await queryGet<{
    workspaceId: string;
    sourceAccountId: string | null;
    reservationId: string | null;
  }>(
    handles,
    anyDb(handles)
      .select({
        workspaceId: t.surplusCases.workspaceId,
        sourceAccountId: t.surplusCases.sourceAccountId,
        reservationId: t.surplusCases.reservationId,
      })
      .from(t.surplusCases)
      .where(eq(t.surplusCases.id, input.surplusCaseId)),
  );
  if (!surplus || surplus.workspaceId !== workspaceId) {
    throw new DomainError("surplus_not_found", "Surplus case not found");
  }
  const accountIds = new Set<string>();
  if (surplus.sourceAccountId) accountIds.add(surplus.sourceAccountId);
  let creditCardId: string | null = null;
  if (surplus.reservationId) {
    const reservation = await queryGet<{
      workspaceId: string;
      sourceAccountId: string;
      obligationRefType: string;
      obligationRefId: string;
    }>(
      handles,
      anyDb(handles)
        .select({
          workspaceId: t.reservations.workspaceId,
          sourceAccountId: t.reservations.sourceAccountId,
          obligationRefType: t.reservations.obligationRefType,
          obligationRefId: t.reservations.obligationRefId,
        })
        .from(t.reservations)
        .where(eq(t.reservations.id, surplus.reservationId)),
    );
    if (reservation && reservation.workspaceId === workspaceId) {
      accountIds.add(reservation.sourceAccountId);
      if (reservation.obligationRefType === "billing_cycle") {
        creditCardId = await cycleCreditCardId(handles, workspaceId, reservation.obligationRefId);
      }
    }
  }
  if (input.claimId) {
    const claim = await queryGet<{ workspaceId: string; billingCycleId: string | null }>(
      handles,
      anyDb(handles)
        .select({
          workspaceId: t.claims.workspaceId,
          billingCycleId: t.claims.billingCycleId,
        })
        .from(t.claims)
        .where(eq(t.claims.id, input.claimId)),
    );
    if (claim && claim.workspaceId === workspaceId && claim.billingCycleId) {
      creditCardId = (await cycleCreditCardId(handles, workspaceId, claim.billingCycleId)) ?? creditCardId;
    }
  }
  if (input.billingCycleId) {
    creditCardId = (await cycleCreditCardId(handles, workspaceId, input.billingCycleId)) ?? creditCardId;
  }
  return { creditCardId, accountIds: [...accountIds] };
}
