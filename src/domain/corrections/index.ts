export { CORRECTION_ERROR_CODES, type CorrectionErrorCode, type TransactionCorrectionRecord, type CorrectionCommandIdentity } from "./types.js";
export { buildTransactionReversal, assertExactReversal, invertPosting } from "./reversal.js";
export {
  correctionRootId,
  correctionHistory,
  correctionCount,
  currentEffectiveLeafId,
  isCurrentEffectiveLeaf,
  firstCorrectionMapping,
  nextCorrectionMapping,
  assertNewCorrectionLink,
  assertAcyclicCorrectionChain,
} from "./chain.js";
export {
  classifyCorrectionCandidate,
  assertCorrectionAvailability,
  assertEventIsCorrectableLeaf,
  type CorrectionEligibility,
  type CorrectionFamily,
  type CorrectionIneligibilityReason,
} from "./eligibility.js";
export { replayCorrectionOrConflict, correctionPayloadMatches } from "./idempotency.js";
export { snapshotAfterReversal } from "./overlay.js";
export {
  correctionsEffectiveAsOf,
  futureCorrectionArtifactIds,
  excludeFutureCorrectionArtifacts,
} from "./history.js";
export {
  activityIdentityFor,
  shouldShowInOrdinaryActivity,
  transactionDetailFromSnapshot,
  type FoldedActivityIdentity,
  type TransactionCorrectionDetail,
} from "./activity.js";
