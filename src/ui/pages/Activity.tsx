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

function shareSummary(event: ActivityEvent): string {
  return event.shares
    .map((share) => `${share.personName} ${formatInr(paise(share.amountPaise))}`)
    .join(" · ");
}

function titleOf(event: ActivityEvent): string {
  if (event.meaning === "income") {
    return event.incomeKind === "salary" ? "Salary" : "Income";
  }
  if (event.meaning === "transfer") return "Moved";
  if (event.meaning === "lend") {
    return `Lent ${event.counterpartyName ?? "someone"} ${formatInr(paise(event.amountPaise))}`;
  }
  if (event.meaning === "borrow") {
    return `Borrowed ${formatInr(paise(event.amountPaise))} from ${event.counterpartyName ?? "someone"}`;
  }
  if (event.meaning === "split") {
    const label = event.merchant ?? "Split";
    return `${formatInr(paise(event.amountPaise))} ${label} · ${shareSummary(event)}`;
  }
  if (event.meaning === "spend_card") {
    if (event.otherOwned) {
      return `Card spend ${formatInr(paise(event.amountPaise))} · ${event.counterpartyName ?? "Someone"}'s`;
    }
    return `${formatInr(paise(event.amountPaise))} · ${event.categories.map((category) => category.name).join(", ")}${event.cardLabel ? ` · ${event.cardLabel}` : ""}`;
  }
  if (event.meaning === "pay_obligation") {
    return `Paid ${formatInr(paise(event.amountPaise))} to ${event.cardLabel ?? "card"}`;
  }
  if (event.meaning === "settlement_in") {
    return `${event.counterpartyName ?? "Someone"} paid you ${formatInr(paise(event.amountPaise))}`;
  }
  if (event.meaning === "settlement_out") {
    return `You paid ${event.counterpartyName ?? "someone"} ${formatInr(paise(event.amountPaise))}`;
  }
  return event.merchant ?? "Spending";
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
            className={`card event${event.meaning === "transfer" || event.meaning === "pay_obligation" || event.meaning === "lend" || event.meaning === "borrow" || event.meaning === "settlement_in" || event.meaning === "settlement_out" || event.otherOwned ? " event-transfer" : ""}`}
            key={event.id}
          >
            <div className="row">
              <strong>{titleOf(event)}</strong>
              <span>
                {event.meaning === "income"
                  ? formatInrDelta(paise(event.amountPaise))
                  : event.meaning === "transfer" ||
                      event.meaning === "spend_card" ||
                      event.meaning === "pay_obligation" ||
                      event.meaning === "split" ||
                      event.meaning === "lend" ||
                      event.meaning === "borrow" ||
                      event.meaning === "settlement_in" ||
                      event.meaning === "settlement_out"
                    ? event.occurredOn
                    : formatInrDelta(paise(-event.amountPaise))}
              </span>
            </div>
            <p className="muted">
              {event.meaning === "transfer" && event.fromAccountName && event.toAccountName
                ? `Moved ${formatInr(paise(event.amountPaise))} from ${event.fromAccountName} to ${event.toAccountName}`
                : event.meaning === "split"
                  ? `${event.occurredOn}${event.accountName ? ` · ${event.accountName}` : ""}${event.cardLabel ? ` · ${event.cardLabel}` : ""}${event.personalAmountPaise > 0 ? ` · Your share ${formatInr(paise(event.personalAmountPaise))}` : " · Not your spend"}`
                  : event.meaning === "lend" || event.meaning === "borrow"
                    ? `${event.occurredOn}${event.accountName ? ` · ${event.accountName}` : ""} · Not spending`
                    : event.meaning === "settlement_in" || event.meaning === "settlement_out"
                      ? `${event.occurredOn}${event.accountName ? ` · ${event.accountName}` : ""} · Not income or spending`
                    : event.meaning === "pay_obligation"
                      ? event.occurredOn
                      : `${event.occurredOn}${event.accountName ? ` · ${event.accountName}` : ""}`}
            </p>
            {event.meaning === "transfer" ? <p className="muted">{event.occurredOn}</p> : null}
            {event.meaning === "settlement_in" || event.meaning === "settlement_out"
              ? event.allocations.map((allocation) => (
                  <p className="muted" key={`${event.id}-${allocation.claimId}`}>
                    {formatInr(paise(allocation.amountPaise))} → {allocation.label}
                  </p>
                ))
              : null}
            {event.consequences?.map((consequence) => (
              <p className="muted" key={`${event.id}-${consequence.kind}-${consequence.label}`}>
                {formatInr(paise(consequence.amountPaise))} {consequence.label}
              </p>
            ))}
            {event.meaning === "spend_card" ||
            event.meaning === "pay_obligation" ||
            event.meaning === "split" ||
            event.meaning === "lend" ||
            event.meaning === "borrow" ||
            event.meaning === "settlement_in" ||
            event.meaning === "settlement_out"
              ? null
              : event.categories.map((category) => (
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
