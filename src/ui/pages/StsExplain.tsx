import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchHome, type HomeView } from "../apiClient.js";
import { cacheHomeView, getCachedHomeView } from "../homeCache.js";

type Props = {
  onBack: () => void;
};

const GROUPS: { id: string; title: string }[] = [
  { id: "in_this_number", title: "In this number" },
  { id: "later_period", title: "Not in this number — later" },
  { id: "not_received", title: "Not in this number — not received" },
  { id: "optional", title: "Not in this number — planned / budgets" },
  { id: "risk", title: "Risks" },
];

export function StsExplain({ onBack }: Props) {
  const cached = getCachedHomeView();
  const [home, setHome] = useState<HomeView | null>(cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;
    fetchHome()
      .then((view) => {
        cacheHomeView(view);
        if (!cancelled) setHome(view);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : "Could not load explanation");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cached]);

  const inThis = home?.explanationItems.filter((item) => item.group === "in_this_number") ?? [];
  const inThisSum = inThis.reduce((sum, item) => sum + item.amountPaise, 0);

  return (
    <main className="page">
      <header className="header">
        <button className="linkish" type="button" onClick={onBack}>
          Back
        </button>
        <h1>Safe to spend</h1>
        <span />
      </header>
      {error ? <p className="danger">{error}</p> : null}
      {home ? (
        <>
          <section className="card">
            <p className="muted">Safe to spend</p>
            <p className="hero-number">{formatInr(paise(home.currentCycleSafeToSpend))}</p>
          </section>
          {GROUPS.map((group) => {
            const lines = home.explanationItems.filter((item) => item.group === group.id);
            if (lines.length === 0) return null;
            return (
              <section key={group.id} className="card">
                <h2>{group.title}</h2>
                {lines.map((item) => (
                  <div key={`${item.group}-${item.label}`} className="row">
                    <span>{item.label}</span>
                    <strong>{item.amountPaise === 0 ? "—" : formatInr(paise(item.amountPaise))}</strong>
                  </div>
                ))}
              </section>
            );
          })}
          <p className="muted">
            In this number totals {formatInr(paise(inThisSum))}, matching Safe to spend.
          </p>
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </main>
  );
}
