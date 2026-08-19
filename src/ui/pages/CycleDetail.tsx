import { useEffect, useState, type FormEvent } from "react";
import { formatInr, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, confirmStatement, fetchCycle } from "../apiClient.js";
import { ErrorState, PageHeader, Skeleton } from "../chrome.js";
import type { AddIntent } from "./Add.js";

type Props = {
  cycleId: string;
  onBack: () => void;
  onCapture: (
    intent: Extract<AddIntent, "card_spend" | "pay_card">,
    defaults: { cardId: string; cycleId: string },
  ) => void;
};

export function CycleDetail({ cycleId, onBack, onCapture }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [actualAmount, setActualAmount] = useState("");
  const [actualStatementOn, setActualStatementOn] = useState("");
  const [actualDueOn, setActualDueOn] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
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

  return (
    <>
      <PageHeader title={cycle?.card.label ?? "Cycle"} onBack={onBack} />
      <main className="page" data-screen="cycle-detail">
        {error ? <ErrorState message={error} /> : null}
        {!cycle && !error ? (
          <Skeleton rows={4} />
        ) : cycle ? (
          <>
            <section className="card stack">
              <div>
                <p className="muted">To pay</p>
                <p className="hero-number">{formatInr(paise(cycle.remainingPaise))}</p>
                <p className="muted">Due {cycle.dueOn}</p>
              </div>
              <div className="row">
                <span>Paid</span>
                <strong>{formatInr(paise(cycle.amountPaidPaise))}</strong>
              </div>
              <div className="stack">
                {cycle.remainingPaise > 0 ? (
                  <button
                    className="primary"
                    type="button"
                    onClick={() =>
                      onCapture("pay_card", { cardId: cycle.card.id, cycleId })
                    }
                  >
                    Pay this card
                  </button>
                ) : null}
                <button
                  className={cycle.remainingPaise > 0 ? "secondary" : "primary"}
                  type="button"
                  onClick={() =>
                    onCapture("card_spend", { cardId: cycle.card.id, cycleId })
                  }
                >
                  Add purchase
                </button>
              </div>
            </section>

            <button className="text-action" type="button" onClick={() => setDetailsOpen((open) => !open)}>
              {detailsOpen ? "Hide details" : "See details"}
            </button>
            {detailsOpen ? (
              <section className="card stack">
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
                  <span>Ledger remaining</span>
                  <strong>{formatInr(paise(cycle.ledgerRemainingPaise))}</strong>
                </div>
                <div className="row">
                  <span>Statement remaining</span>
                  <strong>{formatInr(paise(cycle.statementRemainingPaise))}</strong>
                </div>
                <div className="row">
                  <span>Reserved toward cycle</span>
                  <strong>{formatInr(paise(cycle.reservedTowardCyclePaise ?? 0))}</strong>
                </div>
                <div className="row">
                  <span>Still unfunded</span>
                  <strong>{formatInr(paise(cycle.unfundedPaise ?? cycle.remainingPaise))}</strong>
                </div>
                <p className="muted">
                  {cycle.purchaseWindowStart} → {cycle.purchaseWindowEnd}
                </p>
              </section>
            ) : null}

            {cycle.mismatch ? (
              <div className="card">
                <p className="danger">
                  Statement mismatch: statement is{" "}
                  {formatInr(paise(cycle.actualStatementAmountPaise ?? 0))} vs tracked cycle activity{" "}
                  {formatInr(paise(cycle.expectedAmountPaise))}. This cycle is not fully reconciled.
                </p>
              </div>
            ) : null}

            <p className="section-label">Spends</p>
            {cycle.spends.length === 0 ? <p className="muted">None.</p> : null}
            {cycle.spends.map((spend) => (
              <div className="list-row" key={spend.id}>
                <span className="list-row-copy">
                  <span className="list-row-title">
                    {formatInr(paise(spend.amountPaise))}
                  </span>
                  {spend.categories[0] ? (
                    <span className="list-row-meta">
                      {spend.categories.map((item) => item.name).join(", ")}
                    </span>
                  ) : null}
                </span>
                <span className="muted">{spend.occurredOn}</span>
              </div>
            ))}

            <p className="section-label">Payments</p>
            {cycle.payments.length === 0 ? <p className="muted">None.</p> : null}
            {cycle.payments.map((payment) => (
              <div className="list-row" key={payment.id}>
                <span className="list-row-copy">
                  <span className="list-row-title">
                    Paid {formatInr(paise(payment.amountPaise))}
                  </span>
                  {payment.accountName ? (
                    <span className="list-row-meta">from {payment.accountName}</span>
                  ) : null}
                </span>
                <span className="muted">{payment.occurredOn}</span>
              </div>
            ))}

            <form className="card stack" onSubmit={(event) => void onConfirm(event)}>
              <p className="section-label" style={{ margin: 0 }}>Record actual statement</p>
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
          </>
        ) : null}
      </main>
    </>
  );
}
