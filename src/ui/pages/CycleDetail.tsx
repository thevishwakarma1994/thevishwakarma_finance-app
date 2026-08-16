import { useEffect, useState, type FormEvent } from "react";
import { formatInr, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, confirmStatement, fetchCycle } from "../apiClient.js";

type Props = {
  cycleId: string;
  onBack: () => void;
};

export function CycleDetail({ cycleId, onBack }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [actualAmount, setActualAmount] = useState("");
  const [actualStatementOn, setActualStatementOn] = useState("");
  const [actualDueOn, setActualDueOn] = useState("");
  const [cycle, setCycle] = useState<Awaited<ReturnType<typeof fetchCycle>> | null>(null);

  useEffect(() => {
    fetchCycle(cycleId)
      .then((data) => {
        setCycle(data);
        setActualAmount(
          data.actualStatementAmountPaise !== null
            ? String(data.actualStatementAmountPaise / 100)
            : String(data.expectedAmountPaise / 100),
        );
        setActualStatementOn(data.actualStatementOn ?? data.expectedStatementOn);
        setActualDueOn(data.actualDueOn ?? data.expectedDueOn);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load cycle");
      });
  }, [cycleId]);

  async function onConfirm(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const result = await confirmStatement({
        cycleId,
        actualStatementAmountPaise: parseInr(actualAmount),
        actualStatementOn,
        actualDueOn,
      });
      setWarning(result.warning);
      const data = await fetchCycle(cycleId);
      setCycle(data);
      setActualAmount(
        data.actualStatementAmountPaise !== null
          ? String(data.actualStatementAmountPaise / 100)
          : String(data.expectedAmountPaise / 100),
      );
      setActualStatementOn(data.actualStatementOn ?? data.expectedStatementOn);
      setActualDueOn(data.actualDueOn ?? data.expectedDueOn);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save statement");
    }
  }

  if (!cycle) {
    return (
      <>
        <header className="header">
          <h1>Cycle</h1>
          <button className="linkish" type="button" onClick={onBack}>
            Back
          </button>
        </header>
        <main className="page">
          {error ? <p className="danger">{error}</p> : <p className="muted">Loading…</p>}
        </main>
      </>
    );
  }

  return (
    <>
      <header className="header">
        <h1>{cycle.card.label}</h1>
        <button className="linkish" type="button" onClick={onBack}>
          Back
        </button>
      </header>
      <main className="page">
        <section className="card">
          <p className="muted">
            {cycle.purchaseWindowStart} → {cycle.purchaseWindowEnd}
          </p>
          <div className="row">
            <span>Expected statement</span>
            <strong>{formatInr(paise(cycle.expectedAmountPaise))}</strong>
          </div>
          <div className="row">
            <span>Actual statement</span>
            <strong>
              {cycle.actualStatementAmountPaise === null
                ? "Not recorded"
                : formatInr(paise(cycle.actualStatementAmountPaise))}
            </strong>
          </div>
          <div className="row">
            <span>Paid</span>
            <strong>{formatInr(paise(cycle.amountPaidPaise))}</strong>
          </div>
          <div className="row">
            <span>Ledger remaining</span>
            <strong>{formatInr(paise(cycle.ledgerRemainingPaise))}</strong>
          </div>
          <div className="row">
            <span>Statement remaining</span>
            <strong>{formatInr(paise(cycle.statementRemainingPaise))}</strong>
          </div>
          <p className="muted">
            Due {cycle.dueOn} · {cycle.lifecycle.replaceAll("_", " ")}
          </p>
          {cycle.mismatch ? (
            <p className="danger">
              Statement mismatch: statement is{" "}
              {formatInr(paise(cycle.actualStatementAmountPaise ?? 0))} vs tracked cycle activity{" "}
              {formatInr(paise(cycle.expectedAmountPaise))}. This cycle is not fully reconciled.
            </p>
          ) : null}
        </section>
        <section className="card stack">
          <p>Spends</p>
          {cycle.spends.length === 0 ? <p className="muted">None.</p> : null}
          {cycle.spends.map((spend) => (
            <div key={spend.id}>
              <div className="row">
                <span>
                  {formatInr(paise(spend.amountPaise))}
                  {spend.categories[0] ? ` · ${spend.categories.map((item) => item.name).join(", ")}` : ""}
                </span>
                <span className="muted">{spend.occurredOn}</span>
              </div>
            </div>
          ))}
        </section>
        <section className="card stack">
          <p>Payments</p>
          {cycle.payments.length === 0 ? <p className="muted">None.</p> : null}
          {cycle.payments.map((payment) => (
            <div className="row" key={payment.id}>
              <span>
                Paid {formatInr(paise(payment.amountPaise))}
                {payment.accountName ? ` from ${payment.accountName}` : ""}
              </span>
              <span className="muted">{payment.occurredOn}</span>
            </div>
          ))}
        </section>
        <form className="card stack" onSubmit={(event) => void onConfirm(event)}>
          <p>Record actual statement</p>
          <label>
            Actual amount (INR)
            <input
              inputMode="decimal"
              value={actualAmount}
              onChange={(event) => setActualAmount(event.target.value)}
              required
            />
          </label>
          <label>
            Statement date
            <input
              type="date"
              value={actualStatementOn}
              onChange={(event) => setActualStatementOn(event.target.value)}
              required
            />
          </label>
          <label>
            Due date
            <input
              type="date"
              value={actualDueOn}
              onChange={(event) => setActualDueOn(event.target.value)}
              required
            />
          </label>
          <button className="primary" type="submit">
            Save statement
          </button>
        </form>
        {warning ? <p className="danger">{warning}</p> : null}
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
