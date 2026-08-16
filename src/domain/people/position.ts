import { paise, sumPaise, type Paise } from "../money/paise.js";
import type { LedgerClaim } from "../ledger/types.js";

export type PersonPosition = {
  theyOwePaise: Paise;
  youOwePaise: Paise;
  netPaise: Paise;
  openItemCount: number;
};

export function personPosition(claims: LedgerClaim[], personId: string): PersonPosition {
  const open = claims.filter((claim) => claim.personId === personId && claim.status === "open");
  const theyOwePaise = sumPaise(
    open.filter((claim) => claim.direction === "they_owe_user").map((claim) => claim.openAmountPaise),
  );
  const youOwePaise = sumPaise(
    open.filter((claim) => claim.direction === "user_owes_them").map((claim) => claim.openAmountPaise),
  );
  return {
    theyOwePaise,
    youOwePaise,
    netPaise: paise(theyOwePaise - youOwePaise),
    openItemCount: open.length,
  };
}
