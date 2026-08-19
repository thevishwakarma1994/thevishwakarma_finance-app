import { useEffect, useState } from "react";
import { ApiError, fetchAccounts, updateAccount, type Account } from "../apiClient.js";
import { PageHeader, Sheet } from "../chrome.js";

type Props = {
  onBack: () => void;
};

export function ManageSalary({ onBack }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  function load() {
    return fetchAccounts().then((data) => setAccounts(data.accounts));
  }

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load salary");
    });
  }, []);

  const salaryAccount = accounts.find((account) => account.isPrimarySalary);

  return (
    <>
      <PageHeader title="Salary" onBack={onBack} />
      <main className="page" data-screen="manage-salary">
        {error ? <p className="danger">{error}</p> : null}
        <p className="page-lead muted">Which account salary lands in. Record a payday with Add → I got paid.</p>

        <p className="section-label">Salary account</p>
        <button className="list-row" type="button" onClick={() => setPicking(true)}>
          <span className="list-row-copy">
            <span className="list-row-title">{salaryAccount ? salaryAccount.displayName : "None selected"}</span>
            {salaryAccount ? (
              <span className="muted">{salaryAccount.kind === "cash" ? "Cash" : "Bank"}</span>
            ) : (
              <span className="muted">Choose the account salary is deposited into</span>
            )}
          </span>
          <span className="muted">Change</span>
        </button>

        <p className="section-label">Schedule</p>
        <div className="status-block">
          <p className="list-row-title">Not configured in the app yet</p>
          <p className="muted">
            Safe to spend still works. A salary window cannot be set here yet.
          </p>
        </div>
      </main>
      {picking ? (
        <Sheet title="Salary account" onClose={() => setPicking(false)}>
          {accounts.length === 0 ? (
            <p className="muted">Add a bank account first, then mark it as the salary account.</p>
          ) : null}
          {accounts.map((account) => (
            <button
              className="list-row"
              type="button"
              key={account.id}
              onClick={() =>
                void updateAccount({ accountId: account.id, isPrimarySalary: true })
                  .then(() => {
                    setPicking(false);
                    return load();
                  })
                  .catch((caught: unknown) => {
                    setError(caught instanceof ApiError ? caught.message : "Could not update");
                  })
              }
            >
              <span className="list-row-copy">
                <span className="list-row-title">{account.displayName}</span>
                <span className="muted">{account.kind === "cash" ? "Cash" : "Bank"}</span>
              </span>
              <span className="muted">{account.isPrimarySalary ? "Current" : "Use this"}</span>
            </button>
          ))}
        </Sheet>
      ) : null}
    </>
  );
}
