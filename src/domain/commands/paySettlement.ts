import type { ConsequencePreview, LedgerSnapshot, ProposedBatch } from "../ledger/types.js";
import {
  assertConfirmedAllocations,
  buildSettlementBatch,
  type SettleInput,
} from "./settle.js";

export type PaySettlementInput = SettleInput;

export function paySettlement(
  input: PaySettlementInput,
  snapshot: LedgerSnapshot,
): { batch: ProposedBatch; preview: ConsequencePreview } {
  const claims = assertConfirmedAllocations(
    snapshot,
    input.personId,
    input.amountPaise,
    input.allocations,
    "user_owes_them",
  );
  return buildSettlementBatch({
    meaning: "settlement_out",
    settle: input,
    snapshot,
    claims,
  });
}
