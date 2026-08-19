import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchHome, type HomeView } from "../apiClient.js";
import { cacheHomeView, getCachedHomeView } from "../homeCache.js";
import { ErrorState, PageHeader, Skeleton } from "../chrome.js";

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
  const [loading, setLoading] = useState(!cached);

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
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cached]);

  const inThis = home?.explanationItems.filter((item) => item.group === "in_this_number") ?? [];
  const inThisSum = inThis.reduce((sum, item) => sum + item.amountPaise, 0);

  return (
    <>
      <PageHeader title="Safe to spend" onBack={onBack} />
      <main className="page" data-screen="sts-explain">
        {loading ? <Skeleton rows={5} /> : null}
        {error ? <ErrorState message={error} /> : null}

        {home ? (
          <>
            <section className="card stack">
              <div>
                <p className="muted">Safe to spend</p>
                <p className="hero-number">{formatInr(paise(home.currentCycleSafeToSpend))}</p>
              </div>
            </section>

            {GROUPS.map((group) => {
              const lines = home.explanationItems.filter((item) => item.group === group.id);
              if (lines.length === 0) return null;
              return (
                <section key={group.id} className="card stack">
                  <p className="section-label" style={{ margin: 0 }}>{group.title}</p>
                  {lines.map((item) => (
                    <div key={`${item.group}-${item.label}`} className="row">
                      <span>{item.label}</span>
                      <strong>{item.amountPaise === 0 ? "—" : formatInr(paise(item.amountPaise))}</strong>
                    </div>
                  ))}
                </section>
              );
            })}

            <div className="card">
              <p className="muted" style={{ margin: 0 }}>
                In this number totals {formatInr(paise(inThisSum))}, matching Safe to spend.
              </p>
            </div>
          </>
        ) : null}
      </main>
    </>
  );
}
