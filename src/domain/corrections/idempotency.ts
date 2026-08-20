import { DomainError } from "../ledger/types.js";
import type { CorrectionCommandIdentity, TransactionCorrectionRecord } from "./types.js";

export function correctionPayloadMatches(
  existing: Pick<
    TransactionCorrectionRecord,
    "rootEventId" | "targetEventId" | "reversalEventId" | "replacementEventId" | "reason"
  >,
  incoming: Pick<
    CorrectionCommandIdentity,
    "rootEventId" | "targetEventId" | "reversalEventId" | "replacementEventId" | "reason"
  >,
): boolean {
  return (
    existing.rootEventId === incoming.rootEventId &&
    existing.targetEventId === incoming.targetEventId &&
    existing.reversalEventId === incoming.reversalEventId &&
    existing.replacementEventId === incoming.replacementEventId &&
    (existing.reason ?? null) === (incoming.reason ?? null)
  );
}

export function replayCorrectionOrConflict(
  existing: Pick<
    TransactionCorrectionRecord,
    "workspaceId" | "rootEventId" | "targetEventId" | "reversalEventId" | "replacementEventId" | "reason"
  >,
  incoming: CorrectionCommandIdentity,
): "replay" {
  if (existing.workspaceId !== incoming.workspaceId) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  if (!correctionPayloadMatches(existing, incoming)) {
    throw new DomainError("idempotency_conflict", "Command ID conflict");
  }
  return "replay";
}
