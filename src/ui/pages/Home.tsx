import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchHome, signOut, type HomeView } from "../apiClient.js";

type Props = {
  onOpenExplanation: () => void;
  onOpenAffordability: () => void;
  onOpenMonth: () => void;
  onOpenPeople: () => void;
  onOpenCycle: (cycleId: string) => void;
  onAdd: () => void;
  onSignedOut: () => void;
};

function salaryCopy(home: HomeView): string {
  if (!home.incomePolicyConfigured) {
    return "Salary schedule not configured";
  }
  if (home.delayed) {
    return `Salary expected ${home.salaryWindowStart ?? ""}–${home.salaryWindowEnd ?? ""} has not arrived`;
  }
  if (home.salaryStatus === "window_open_unreceived") {
    return `Salary window ${home.salaryWindowStart ?? ""}–${home.salaryWindowEnd ?? ""} · not in yet`;
  }
  if (home.salaryWindowStart) {
    return `Next salary window ${home.salaryWindowStart}–${home.salaryWindowEnd}`;
  }
  return "Salary schedule not configured";
}

export function Home({
  onOpenExplanation,
  onOpenAffordability,
  onOpenMonth,
  onOpenPeople,
  onOpenCycle,
  onAdd,
  onSignedOut,
}: Props) {
  const [home, setHome] = useState<HomeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHome()
      .then(setHome)
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load Home");
      });
  }, []);

  return (
    <main className="page">
      <header className="header">
        <h1>Home</h1>
        <button
          className="linkish"
          type="button"
          onClick={() => {
            void signOut().then(onSignedOut);
          }}
        >
          Sign out
        </button>
      </header>
      {error ? <p className="danger">{error}</p> : null}
      {home ? (
        <>
          <button className="card link-card" type="button" onClick={onOpenExplanation}>
            <p className="muted">Safe to spend</p>
            <p className={`hero-number${home.currentCycleSafeToSpend < 0 ? " danger" : ""}`}>
              {formatInr(paise(home.currentCycleSafeToSpend))}
            </p>
            <p className="muted">After reserved money and must-pays before next salary</p>
          </button>
          <section className="card">
            <div className="row">
              <span>You have</span>
              <strong>{formatInr(paise(home.liquidTotal))}</strong>
            </div>
            <div className="row">
              <span>Reserved</span>
              <strong>{formatInr(paise(home.reservedTotal))}</strong>
            </div>
            <div className="row">
              <span>Available</span>
              <strong>{formatInr(paise(home.availableLiquid))}</strong>
            </div>
          </section>
          <p className="muted">{salaryCopy(home)}</p>
          {home.riskFlags.some((flag) => flag !== "salary_schedule_not_configured")
            ? home.explanationItems
                .filter(
                  (item) =>
                    item.group === "risk" && item.label !== "Salary schedule not configured",
                )
                .map((item) => (
                  <p key={item.label} className="danger">
                    {item.label}
                  </p>
                ))
            : null}
          <div className="actions">
            <button className="primary" type="button" onClick={onAdd}>
              Add
            </button>
            <button className="secondary" type="button" onClick={onOpenAffordability}>
              Can I spend ₹X?
            </button>
          </div>
          {home.coming.length > 0 ? (
            <section>
              <h2>Coming up</h2>
              {home.coming.map((item) => (
                <button
                  key={item.cycleId}
                  className="card link-card"
                  type="button"
                  onClick={() => onOpenCycle(item.cycleId)}
                >
                  <div className="row">
                    <span>{item.cardLabel}</span>
                    <strong>{formatInr(paise(item.remainingPaise))}</strong>
                  </div>
                  <p className="muted">Due {item.dueOn}</p>
                </button>
              ))}
            </section>
          ) : null}
          <button className="card link-card" type="button" onClick={onOpenMonth}>
            <div className="row">
              <span>This month</span>
              <strong>{formatInr(paise(home.monthSpentPaise))}</strong>
            </div>
            <p className="muted">Last month {formatInr(paise(home.previousMonthSpentPaise))}</p>
          </button>
          {home.people.length > 0 ? (
            <button className="card link-card" type="button" onClick={onOpenPeople}>
              <h2>People</h2>
              {home.people.map((person) => (
                <div key={person.id} className="row">
                  <span>{person.name}</span>
                  <strong>{formatInr(paise(person.netPaise))}</strong>
                </div>
              ))}
            </button>
          ) : null}
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </main>
  );
}
