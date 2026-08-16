import { useEffect, useState, type FormEvent } from "react";
import { formatInr, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  fetchAccounts,
  fetchMonth,
  previewOrCommitOpening,
  signOut,
  type Account,
  type MonthSpend,
} from "../apiClient.js";

type Props = {
  onSignedOut: () => void;
};

export function Money({ onSignedOut }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [month, setMonth] = useState<MonthSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingAccountId, setOpeningAccountId] = useState<string | null>(null);
  const [openingAmount, setOpeningAmount] = useState("");

  function load() {
    return Promise.all([fetchAccounts(), fetchMonth()]).then(([accountData, monthData]) => {
      setAccounts(accountData.accounts);
      setMonth(monthData);
    });
  }

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchMonth()])
      .then(([accountData, monthData]) => {
        setAccounts(accountData.accounts);
        setMonth(monthData);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load accounts");
      });
  }, []);

  async function onSignOut() {
    try {
      await signOut();
    } catch {
      // Cookie/session may already be gone.
    }
    onSignedOut();
  }

  async function onOpening(event: FormEvent) {
    event.preventDefault();
    if (!openingAccountId) return;
    setError(null);
    try {
      await previewOrCommitOpening({
        accountId: openingAccountId,
        effectiveOn: todayKolkata(),
        balancePaise: parseInr(openingAmount),
        commit: true,
      });
      setOpeningAccountId(null);
      setOpeningAmount("");
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not set opening");
    }
  }

  return (
    <>
      <header className="header">
        <h1>Money</h1>
        <button className="linkish" type="button" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </header>
      <main className="page">
        {month ? (
          <section className="card">
            <p className="muted">Personal spending · {month.month}</p>
            <p className="balance">{formatInr(paise(month.spentPaise))}</p>
          </section>
        ) : null}
        {accounts.map((account) => (
          <section className="card" key={account.id}>
            <div className="row">
              <strong>
                {account.displayName}
                {account.mask ? ` · ${account.mask}` : ""}
              </strong>
              <span>{formatInr(paise(account.balancePaise))}</span>
            </div>
            <p className="muted">Derived from opening + account movements</p>
            <button
              className="secondary"
              type="button"
              onClick={() => setOpeningAccountId(account.id)}
            >
              Set opening balance
            </button>
          </section>
        ))}
        {openingAccountId ? (
          <form className="card stack" onSubmit={onOpening}>
            <p>Starting balance — this is not income.</p>
            <label>
              Amount (INR)
              <input
                inputMode="decimal"
                value={openingAmount}
                onChange={(event) => setOpeningAmount(event.target.value)}
                required
              />
            </label>
            <button className="primary" type="submit">
              Save opening
            </button>
          </form>
        ) : null}
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
