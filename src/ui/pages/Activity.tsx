import { useEffect, useState } from "react";
import { formatInr, formatInrDelta } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchActivity, type ActivityEvent } from "../apiClient.js";

function filtersFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    categoryId: params.get("categoryId") ?? undefined,
    month: params.get("month") ?? undefined,
  };
}

export function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const filter = filtersFromLocation();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextFilter = {
      categoryId: params.get("categoryId") ?? undefined,
      month: params.get("month") ?? undefined,
    };
    fetchActivity(nextFilter)
      .then((data) => setEvents(data.events))
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load activity");
      });
  }, []);

  return (
    <>
      <header className="header">
        <h1>Activity</h1>
      </header>
      <main className="page">
        {filter.categoryId || filter.month ? (
          <p className="muted">
            Filtered
            {filter.month ? ` · ${filter.month}` : ""}
          </p>
        ) : null}
        {events.length === 0 ? <p className="muted">No movements yet.</p> : null}
        {events.map((event) => (
          <article
            className={`card event${event.meaning === "transfer" ? " event-transfer" : ""}`}
            key={event.id}
          >
            <div className="row">
              <strong>
                {event.meaning === "income"
                  ? event.incomeKind === "salary"
                    ? "Salary"
                    : "Income"
                  : event.meaning === "transfer"
                    ? "Moved"
                    : (event.merchant ?? "Spending")}
              </strong>
              <span>
                {event.meaning === "income"
                  ? formatInrDelta(paise(event.amountPaise))
                  : event.meaning === "transfer"
                    ? formatInr(paise(event.amountPaise))
                    : formatInrDelta(paise(-event.amountPaise))}
              </span>
            </div>
            <p className="muted">
              {event.meaning === "transfer" && event.fromAccountName && event.toAccountName
                ? `Moved ${formatInr(paise(event.amountPaise))} from ${event.fromAccountName} to ${event.toAccountName}`
                : `${event.occurredOn}${event.accountName ? ` · ${event.accountName}` : ""}`}
            </p>
            {event.meaning === "transfer" ? <p className="muted">{event.occurredOn}</p> : null}
            {event.categories.map((category) => (
              <p className="muted" key={`${event.id}-${category.name}`}>
                {category.name} {formatInr(paise(category.amountPaise))}
              </p>
            ))}
          </article>
        ))}
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
