import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  fetchAccounts,
  fetchObligation,
  previewOrCommitPayObligation,
  skipObligation,
  type Account,
} from "../apiClient.js";

type Props = {
  instanceId: string;
  onBack: () => void;
};

export function ObligationDetail({ instanceId, onBack }: Props) {
  const [name, setName] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [amountPaise, setAmountPaise] = useState(0);
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    return Promise.all([fetchObligation(instanceId), fetchAccounts()]).then(([detail, accountData]) => {
      setName(detail.nameSnapshot);
      setDueOn(detail.dueOn);
      setAmountPaise(detail.remainingPaise || detail.amountPaise);
      setStatus(detail.status);
      setPriority(detail.prioritySnapshot);
      setAccounts(accountData.accounts);
      setAccountId(detail.defaultAccountId ?? accountData.accounts[0]?.id ?? "");
    });
  }, [instanceId]);

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load obligation");
    });
  }, [load]);

  async function onPay(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await previewOrCommitPayObligation({
        occurredOn: todayKolkata(),
        instanceId,
        accountId,
        amountPaise,
        commit: true,
      });
      await load();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : "Could not pay");
    } finally {
      setBusy(false);
    }
  }

  async function onSkip() {
    setBusy(true);
    setError(null);
    try {
      await skipObligation({ instanceId });
      await load();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : "Could not skip");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="header">
        <button className="linkish" type="button" onClick={onBack}>
          Back
        </button>
        <h1>{name || "Obligation"}</h1>
        <span />
      </header>
      {error ? <p className="danger">{error}</p> : null}
      <section className="card">
        <div className="row">
          <span>Due</span>
          <strong>{dueOn}</strong>
        </div>
        <div className="row">
          <span>Amount</span>
          <strong>{formatInr(paise(amountPaise))}</strong>
        </div>
        <p className="muted">
          {priority.replace("_", " ")} · {status}
        </p>
      </section>
      {status === "open" ? (
        <form className="card" onSubmit={(event) => void onPay(event)}>
          <label>
            Pay from
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button className="primary" disabled={busy} type="submit">
              Mark paid
            </button>
            <button className="secondary" disabled={busy} type="button" onClick={() => void onSkip()}>
              Skip
            </button>
          </div>
        </form>
      ) : null}
    </main>
  );
}
