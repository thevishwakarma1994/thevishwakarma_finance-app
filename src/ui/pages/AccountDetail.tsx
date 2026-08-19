import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchAccounts, type Account } from "../apiClient.js";
import { ErrorState, PageHeader, Skeleton } from "../chrome.js";

type Props = {
  accountId: string;
  onBack: () => void;
  onMoveMoney: (accountId: string) => void;
};

export function AccountDetail({ accountId, onBack, onMoveMoney }: Props) {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAccounts()
      .then((data) => {
        setAccount(data.accounts.find((item) => item.id === accountId) ?? null);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load account");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [accountId]);

  return (
    <>
      <PageHeader title={account?.displayName ?? "Account"} onBack={onBack} />
      <main className="page" data-screen="account-detail">
        {loading ? <Skeleton rows={3} /> : null}
        {error ? <ErrorState message={error} /> : null}
        {account ? (
          <section className="card stack">
            <div>
              <p className="muted">Balance</p>
              <p className="hero-number">{formatInr(paise(account.balancePaise))}</p>
            </div>
            {(account.reservedPaise ?? 0) > 0 ? (
              <div className="stack">
                <p className="muted" style={{ margin: 0 }}>Reserved {formatInr(paise(account.reservedPaise ?? 0))}</p>
                {(account.reservedDetails ?? []).map((detail) => (
                  <p className="muted" key={detail.reservationId} style={{ margin: 0 }}>
                    {formatInr(paise(detail.amountPaise))} for {detail.cardLabel}
                    {detail.dueOn ? ` due ${detail.dueOn}` : ""}
                  </p>
                ))}
              </div>
            ) : null}
            <button className="primary" type="button" onClick={() => onMoveMoney(account.id)}>
              Move money
            </button>
          </section>
        ) : null}
      </main>
    </>
  );
}
