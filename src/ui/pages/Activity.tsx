import { useEffect, useState } from "react";
import { formatInr, formatInrDelta } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchActivity, type ActivityEvent } from "../apiClient.js";

export function Activity() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActivity()
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
        {events.length === 0 ? <p className="muted">No income or spending yet.</p> : null}
        {events.map((event) => (
          <article className="card event" key={event.id}>
            <div className="row">
              <strong>
                {event.meaning === "income"
                  ? event.incomeKind === "salary"
                    ? "Salary"
                    : "Income"
                  : (event.merchant ?? "Spending")}
              </strong>
              <span>
                {event.meaning === "income"
                  ? formatInrDelta(paise(event.amountPaise))
                  : formatInrDelta(paise(-event.amountPaise))}
              </span>
            </div>
            <p className="muted">
              {event.occurredOn}
              {event.accountName ? ` · ${event.accountName}` : ""}
            </p>
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
