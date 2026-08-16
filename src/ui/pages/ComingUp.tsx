import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchComingUp, type ComingUpItem, type ComingUpView } from "../apiClient.js";

type Props = {
  onBack: () => void;
  onOpenCycle: (cycleId: string) => void;
  onOpenObligation: (id: string) => void;
};

const FILTERS: { id: ComingUpView["filter"]; label: string }[] = [
  { id: "all_open", label: "All open" },
  { id: "overdue", label: "Overdue" },
  { id: "next_10_days", label: "Next 10 days" },
  { id: "until_next_salary", label: "Until next salary" },
  { id: "this_salary_period", label: "This salary period" },
];

function statusLine(item: ComingUpItem): string {
  if (item.uncertainWindow) return "Due inside salary window";
  if (item.reservedPaise > 0 && item.unfundedPaise === 0) return "Reserved";
  if (item.reservedPaise > 0) return "Partly funded";
  if (item.overdue) return "Overdue";
  return "Needs funding";
}

export function ComingUp({ onBack, onOpenCycle, onOpenObligation }: Props) {
  const [filter, setFilter] = useState("all_open");
  const [view, setView] = useState<ComingUpView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchComingUp(filter)
      .then(setView)
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load Coming up");
      });
  }, [filter]);

  return (
    <main className="page">
      <header className="header">
        <button className="linkish" type="button" onClick={onBack}>
          Back
        </button>
        <h1>Coming up</h1>
        <span />
      </header>
      {error ? <p className="danger">{error}</p> : null}
      <div className="actions">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            className={filter === item.id ? "primary" : "secondary"}
            type="button"
            onClick={() => setFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {view && !view.filterAvailable ? <p className="muted">{view.filterUnavailableReason}</p> : null}
      {view?.items.map((item) => (
        <button
          key={`${item.kind}-${item.id}`}
          className="card link-card"
          type="button"
          onClick={() => {
            if (item.cycleId) onOpenCycle(item.cycleId);
            else if (item.instanceId) onOpenObligation(item.instanceId);
          }}
        >
          <div className="row">
            <span>
              {item.dueOn} · {item.name}
            </span>
            <strong>{formatInr(paise(item.remainingPaise))}</strong>
          </div>
          <p className="muted">
            {item.type} · {item.priority.replace("_", " ")} · {statusLine(item)}
            {item.fundingPeriodLabel ? ` · ${item.fundingPeriodLabel}` : ""}
            {item.reservedPaise > 0 ? ` · reserved ${formatInr(paise(item.reservedPaise))}` : ""}
            {item.unfundedPaise > 0 ? ` · unfunded ${formatInr(paise(item.unfundedPaise))}` : ""}
            {item.delayedSalary ? " · delayed salary" : ""}
          </p>
        </button>
      ))}
      {view && view.filterAvailable && view.items.length === 0 ? <p className="muted">Nothing coming up.</p> : null}
    </main>
  );
}
