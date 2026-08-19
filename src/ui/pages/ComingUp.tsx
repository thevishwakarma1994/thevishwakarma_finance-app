import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchComingUp, type ComingUpItem, type ComingUpView } from "../apiClient.js";
import { EmptyState, PageHeader } from "../chrome.js";

type Props = {
  onBack: () => void;
  onOpenCycle: (cycleId: string) => void;
  onOpenObligation: (id: string) => void;
};

const FILTERS: { id: ComingUpView["filter"]; label: string }[] = [
  { id: "all_open", label: "All" },
  { id: "overdue", label: "Overdue" },
  { id: "next_10_days", label: "10 days" },
  { id: "until_next_salary", label: "Until salary" },
  { id: "this_salary_period", label: "This salary" },
];

function priorityLabel(priority: ComingUpItem["priority"]): string {
  if (priority === "must_pay") return "Must pay";
  if (priority === "committed") return "Protected";
  return "Planned";
}

function statusLine(item: ComingUpItem): string {
  if (item.overdue) return "Overdue";
  if (item.reservedPaise > 0 && item.unfundedPaise === 0) return "Reserved";
  if (item.uncertainWindow || item.delayedSalary) return "After this salary";
  if (item.unfundedPaise > 0) return "Needs funding";
  return "Reserved";
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
    <>
      <PageHeader title="Coming up" onBack={onBack} />
      <main className="page" data-screen="coming-up">
        {error ? <p className="danger">{error}</p> : null}
        <div className="chips">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? "chip active" : "chip"}
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
            className="list-row"
            type="button"
            onClick={() => {
              if (item.cycleId) onOpenCycle(item.cycleId);
              else if (item.instanceId) onOpenObligation(item.instanceId);
            }}
          >
            <span className="list-row-copy">
              <span className="list-row-title">{item.name}</span>
              <span className="list-row-meta">
                {item.dueOn} · {priorityLabel(item.priority)} · {statusLine(item)}
              </span>
            </span>
            <span className="amount">{formatInr(paise(item.remainingPaise))}</span>
          </button>
        ))}
        {view && view.filterAvailable && view.items.length === 0 ? (
          <EmptyState title="Nothing coming up." />
        ) : null}
      </main>
    </>
  );
}
