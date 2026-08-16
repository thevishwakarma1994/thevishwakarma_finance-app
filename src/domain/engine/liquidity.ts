import { paise, type Paise } from "../money/paise.js";
import { DomainError } from "../ledger/types.js";
import type { LedgerSnapshot, SurplusCaseRecord } from "../ledger/types.js";

export type AccountAvailability = {
  accountId: string;
  balancePaise: Paise;
  reservedActivePaise: Paise;
  pendingSurplusHeldPaise: Paise;
  availablePaise: Paise;
};

function pendingSurplusOnAccount(
  cases: SurplusCaseRecord[],
  accountId: string,
): Paise {
  return paise(
    cases
      .filter(
        (item) =>
          item.status === "pending" &&
          item.sourceAccountId === accountId,
      )
      .reduce((sum, item) => sum + item.amountPaise, 0),
  );
}

export function accountAvailability(
  snapshot: LedgerSnapshot,
  accountId: string,
): AccountAvailability {
  const account = snapshot.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new DomainError("account_not_found", "Account not found");
  }
  const reservedActivePaise = paise(
    snapshot.reservations
      .filter((reservation) => reservation.sourceAccountId === accountId)
      .reduce((sum, reservation) => sum + reservation.remainingPaise, 0),
  );
  const pendingSurplusHeldPaise = pendingSurplusOnAccount(snapshot.surplusCases, accountId);
  const availablePaise = paise(account.balancePaise - reservedActivePaise - pendingSurplusHeldPaise);
  return {
    accountId,
    balancePaise: account.balancePaise,
    reservedActivePaise,
    pendingSurplusHeldPaise,
    availablePaise,
  };
}

export function requireAvailable(
  snapshot: LedgerSnapshot,
  accountId: string,
  amountPaise: Paise,
  action: string,
): AccountAvailability {
  const availability = accountAvailability(snapshot, accountId);
  if (amountPaise <= availability.availablePaise) {
    return availability;
  }
  if (amountPaise <= availability.balancePaise) {
    throw new DomainError(
      "insufficient_available",
      `${action} would use money that is reserved or waiting for review`,
    );
  }
  throw new DomainError(
    "insufficient_balance",
    `${action} exceeds the money currently in the account`,
  );
}
