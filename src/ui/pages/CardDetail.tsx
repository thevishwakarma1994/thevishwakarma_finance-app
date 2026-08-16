import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchCard, updateCard, type ActivityEvent, type CardCycleView } from "../apiClient.js";

type Props = {
  cardId: string;
  onBack: () => void;
  onOpenCycle: (cycleId: string) => void;
};

export function CardDetail({ cardId, onBack, onOpenCycle }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [rename, setRename] = useState("");
  const [data, setData] = useState<{
    displayName: string;
    issuer: string;
    label: string;
    mask: string | null;
    outstandingPaise: number;
    statementDay: number;
    dueDaysAfterStatement: number;
    cycles: CardCycleView[];
    transactions: ActivityEvent[];
  } | null>(null);

  useEffect(() => {
    fetchCard(cardId)
      .then((card) => {
        setData(card);
        setRename(card.displayName);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load card");
      });
  }, [cardId]);

  if (!data) {
    return (
      <>
        <header className="header">
          <h1>Card</h1>
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
        <h1>{data.label}</h1>
        <button className="linkish" type="button" onClick={onBack}>
          Back
        </button>
      </header>
      <main className="page">
        <section className="card">
          <p className="muted">Current outstanding</p>
          <p className="balance">{formatInr(paise(data.outstandingPaise))}</p>
          <p className="muted">
            Statement day {data.statementDay} · due {data.dueDaysAfterStatement} days later
          </p>
        </section>
        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            void updateCard({ cardId, displayName: rename })
              .then(() => fetchCard(cardId))
              .then((card) => {
                setData(card);
                setRename(card.displayName);
              })
              .catch((caught: unknown) => {
                setError(caught instanceof ApiError ? caught.message : "Could not rename");
              });
          }}
        >
          <label>
            Name
            <input value={rename} onChange={(event) => setRename(event.target.value)} />
          </label>
          <button className="secondary" type="submit">
            Rename
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              void updateCard({ cardId, status: "inactive" })
                .then(onBack)
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not archive");
                })
            }
          >
            Archive
          </button>
        </form>
        <section className="card stack">
          <p>Cycles</p>
          {data.cycles.length === 0 ? <p className="muted">No cycles yet.</p> : null}
          {data.cycles.map((cycle) => (
            <button className="link-card" type="button" key={cycle.id} onClick={() => onOpenCycle(cycle.id)}>
              <div className="row">
                <strong>Statement {cycle.expectedStatementOn}</strong>
                <span>{formatInr(paise(cycle.remainingPaise))}</span>
              </div>
              <p className="muted">
                Due {cycle.dueOn} · {cycle.lifecycle.replaceAll("_", " ")}
                {cycle.mismatch ? " · statement mismatch" : ""}
              </p>
            </button>
          ))}
        </section>
        <section className="card stack">
          <p>Transactions</p>
          {data.transactions.length === 0 ? <p className="muted">None yet.</p> : null}
          {data.transactions.map((event) => (
            <div className="row" key={event.id}>
              <span>
                {event.meaning === "pay_obligation"
                  ? `Paid ${formatInr(paise(event.amountPaise))}`
                  : `${formatInr(paise(event.amountPaise))}${event.categories[0] ? ` · ${event.categories[0].name}` : ""}`}
              </span>
              <span className="muted">{event.occurredOn}</span>
            </div>
          ))}
        </section>
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
