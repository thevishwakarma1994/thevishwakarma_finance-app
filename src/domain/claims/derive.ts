import { paise, sumPaise, type Paise } from "../money/paise.js";
import type { ClaimStatus, LedgerClaim, SettlementAllocation } from "../ledger/types.js";

export function allocatedToClaim(
  allocations: SettlementAllocation[],
  claimId: string,
): Paise {
  return sumPaise(
    allocations.filter((item) => item.claimId === claimId).map((item) => item.amountPaise),
  );
}

export function deriveOpenAmount(originalAmountPaise: Paise, allocatedPaise: Paise): Paise {
  const open = originalAmountPaise - allocatedPaise;
  return paise(open < 0 ? 0 : open);
}

export function deriveClaimStatus(stored: ClaimStatus, openAmountPaise: Paise): ClaimStatus {
  if (stored === "void") return "void";
  return openAmountPaise > 0 ? "open" : "settled";
}

export function enrichClaim(
  claim: Omit<LedgerClaim, "openAmountPaise"> & { openAmountPaise?: Paise },
  allocations: SettlementAllocation[],
  correctionDeltasPaise: number = 0,
): LedgerClaim {
  const allocatedPaise = allocatedToClaim(allocations, claim.id);
  const effectivePrincipal = paise(claim.originalAmountPaise + correctionDeltasPaise);
  const openAmountPaise = deriveOpenAmount(effectivePrincipal, allocatedPaise);
  
  const status = deriveClaimStatus(claim.status, openAmountPaise);

  return {
    ...claim,
    openAmountPaise,
    status,
  };
}
