import type { ConsequencePreview, LedgerSnapshot, ProposedBatch } from "../ledger/types.js";
import {
  assertConfirmedAllocations,
  buildSettlementBatch,
  type SettleInput,
} from "./settle.js";

export type ReceiveSettlementInput = SettleInput;

export function receiveSettlement(
  input: ReceiveSettlementInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const claims = assertConfirmedAllocations(
    snapshot,
    input.personId,
    input.amountPaise,
    input.allocations,
    "they_owe_user",
  );
  return buildSettlementBatch({
    meaning: "settlement_in",
    settle: input,
    snapshot,
    claims,
  });
}
