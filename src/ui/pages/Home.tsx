import { useEffect, useState } from "react";
import { DateTime } from "luxon";
import { KOLKATA } from "../../domain/calendar/kolkata.js";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchHome, type HomeView } from "../apiClient.js";
import { cacheHomeView } from "../homeCache.js";
import { EmptyState, ErrorState, PageHeader, RowChevron, Skeleton } from "../chrome.js";

type Props = {
  onOpenExplanation: () => void;
  onOpenAffordability: () => void;
  onOpenMonth: () => void;
  onOpenPeople: () => void;
  onOpenCycle: (cycleId: string) => void;
  onOpenComingUp: () => void;
  onOpenObligation: (id: string) => void;
  onOpenSalary: () => void;
  onOpenMoney: () => void;
};

function formatDayMonth(iso: string): string {
  return DateTime.fromISO(iso, { zone: KOLKATA }).toFormat("d MMM");
}

function salaryCopy(home: HomeView): string {
  if (!home.incomePolicyConfigured) {
    return "Salary schedule not configured";
  }
  if (home.delayed || home.salaryStatus === "salary_delayed") {
    return "Salary hasn't arrived yet";
  }
  if (home.salaryStatus === "window_open_unreceived") {
    return "Salary expected now";
  }
  if (home.salaryTypicalOn) {
    return `Expected around ${formatDayMonth(home.salaryTypicalOn)}`;
  }
  return "Salary schedule not configured";
}

export function Home({
  onOpenExplanation,
  onOpenAffordability,
  onOpenMonth,
  onOpenPeople,
  onOpenCycle,
  onOpenComingUp,
  onOpenObligation,
  onOpenSalary,
  onOpenMoney,
}: Props) {
  const [home, setHome] = useState<HomeView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHome()
      .then((view) => {
        cacheHomeView(view);
        setHome(view);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load Home");
      });
  }, []);

  const salaryUnconfigured = Boolean(home && !home.incomePolicyConfigured);

  return (
    <>
      <PageHeader title="Home" />
      <main className="page" data-screen="home">
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => {
              setError(null);
              fetchHome()
                .then((view) => {
                  cacheHomeView(view);
                  setHome(view);
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not load Home");
                });
            }}
          />
        ) : null}
        {home ? (
          <>
            {salaryUnconfigured ? (
              <button className="text-action" type="button" onClick={onOpenSalary}>
                Salary schedule not configured
              </button>
            ) : (
              <p className="muted">{salaryCopy(home)}</p>
            )}
            <button className="sts" type="button" onClick={onOpenExplanation}>
              <p className="sts-label">Safe to spend</p>
              <p className={`hero-number${home.currentCycleSafeToSpend < 0 ? " danger" : ""}`}>
                {formatInr(paise(home.currentCycleSafeToSpend))}
              </p>
              <p className="muted sts-help">After reserved money and must-pays before next salary</p>
            </button>
            <button className="text-action" type="button" onClick={onOpenAffordability}>
              Can I spend this?
            </button>
            <section>
              <button className="list-row" type="button" onClick={onOpenMoney}>
                <span>You have</span>
                <span className="amount">{formatInr(paise(home.liquidTotal))}</span>
              </button>
              <button className="list-row" type="button" onClick={onOpenMoney}>
                <span>Reserved</span>
                <span className="amount">{formatInr(paise(home.reservedTotal))}</span>
              </button>
            </section>
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
            {home.coming.length > 0 ? (
              <section>
                <div className="section-head">
                  <p className="section-label">Coming up</p>
                  <button className="linkish" type="button" onClick={onOpenComingUp}>
                    See all
                  </button>
                </div>
                {home.coming.map((item) => (
                  <button
                    key={`${item.kind}-${item.id}`}
                    className="list-row"
                    type="button"
                    onClick={() => {
                      if (item.cycleId) onOpenCycle(item.cycleId);
                      else if (item.instanceId) onOpenObligation(item.instanceId);
                    }}
                  >
                    <span className="list-row-copy">
                      <span className="list-row-title">{item.name}</span>
                      <span className="list-row-meta">{item.dueOn}</span>
                    </span>
                    <span className="amount">{formatInr(paise(item.remainingPaise))}</span>
                  </button>
                ))}
              </section>
            ) : (
              <EmptyState title="Nothing due right now." actionLabel="See all" onAction={onOpenComingUp} />
            )}
            <button className="list-row" type="button" onClick={onOpenMonth}>
              <span className="list-row-copy">
                <span className="list-row-title">This month</span>
                <span className="list-row-meta">
                  {home.previousMonthSpentPaise || home.monthSpentPaise
                    ? `Last month ${formatInr(paise(home.previousMonthSpentPaise))}`
                    : "You spent"}
                </span>
              </span>
              <span className="amount">{formatInr(paise(home.monthSpentPaise))}</span>
            </button>
            {home.people.length > 0 ? (
              <button className="list-row" type="button" onClick={onOpenPeople}>
                <span className="list-row-copy">
                  <span className="list-row-title">People</span>
                  <span className="list-row-meta">
                    {home.people
                      .map((person) => `${person.name} ${formatInr(paise(person.netPaise))}`)
                      .join(" · ")}
                  </span>
                </span>
                <RowChevron />
              </button>
            ) : null}
          </>
        ) : error ? null : (
          <Skeleton rows={5} />
        )}
      </main>
    </>
  );
}
