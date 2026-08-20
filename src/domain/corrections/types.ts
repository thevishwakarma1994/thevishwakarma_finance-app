import type { EntityId } from "../ids.js";
import type { IsoDate } from "../calendar/isoDate.js";

export const CORRECTION_ERROR_CODES = [
  "transaction_not_correctable",
  "stale_correction_target",
  "idempotency_conflict",
  "correction_would_use_reserved_money",
  "insufficient_available",
  "invalid_correction_date",
  "unsupported_transaction_family",
] as const;

export type CorrectionErrorCode = (typeof CORRECTION_ERROR_CODES)[number];

export type TransactionCorrectionRecord = {
  id: EntityId;
  workspaceId: EntityId;
  commandId: string;
  rootEventId: EntityId;
  targetEventId: EntityId;
  reversalEventId: EntityId;
  replacementEventId: EntityId;
  correctedOn: IsoDate;
  capturedAt: string;
  reason: string | null;
};

export type CorrectionCommandIdentity = {
  commandId: string;
  workspaceId: EntityId;
  rootEventId: EntityId;
  targetEventId: EntityId;
  reversalEventId: EntityId;
  replacementEventId: EntityId;
  reason: string | null;
};
