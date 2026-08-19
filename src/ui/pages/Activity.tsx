import { useEffect, useState } from "react";
import { formatInr, formatInrDelta } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchActivity, type ActivityEvent } from "../apiClient.js";
import { EmptyState, ErrorState, PageHeader, Skeleton } from "../chrome.js";

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
  if (event.meaning === "transfer") return "Moved money";
  if (event.meaning === "lend") return `Lent ${event.counterpartyName ?? "someone"}`;
  if (event.meaning === "borrow") return `Borrowed from ${event.counterpartyName ?? "someone"}`;
  if (event.meaning === "split") return event.merchant ?? "Split";
  if (event.meaning === "spend_card") {
    if (event.otherOwned) return `${event.counterpartyName ?? "Someone"}'s card spend`;
    return event.merchant ?? (event.categories.map((category) => category.name).join(", ") || "Card spend");
  }
  if (event.meaning === "pay_obligation") return `Paid ${event.cardLabel ?? "card"}`;
  if (event.meaning === "settlement_in") return `${event.counterpartyName ?? "Someone"} paid you`;
  if (event.meaning === "settlement_out") return `You paid ${event.counterpartyName ?? "someone"}`;
  return event.merchant ?? "Spending";
}

function amountOf(event: ActivityEvent): string {
  if (event.meaning === "income") {
    return formatInrDelta(paise(event.amountPaise));
  }
  if (
    event.meaning === "transfer" ||
    event.meaning === "lend" ||
    event.meaning === "borrow" ||
    event.meaning === "settlement_in" ||
    event.meaning === "settlement_out" ||
    event.otherOwned
  ) {
    return formatInr(paise(event.amountPaise));
  }
  if (event.meaning === "split") {
    if (event.personalAmountPaise > 0) {
      return formatInrDelta(paise(-event.personalAmountPaise));
    }
    return formatInr(paise(event.amountPaise));
  }
  return formatInrDelta(paise(-event.amountPaise));
}

function metaOf(event: ActivityEvent): string {
  const bits = [event.occurredOn];
  if (event.meaning === "transfer" && event.fromAccountName && event.toAccountName) {
    bits.push(`${event.fromAccountName} → ${event.toAccountName}`);
  } else if (event.accountName) {
    bits.push(event.accountName);
  }
  if (event.cardLabel && event.meaning !== "pay_obligation") bits.push(event.cardLabel);
  if (event.meaning === "split") bits.push(shareSummary(event) || (event.personalAmountPaise > 0 ? "Your share" : "Not your spend"));
  if (event.meaning === "lend" || event.meaning === "borrow") bits.push("Not spending");
  if (event.meaning === "settlement_in" || event.meaning === "settlement_out") bits.push("Not income or spending");
  return bits.filter(Boolean).join(" · ");
}

export function Activity() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
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
      <PageHeader title="Activity" />
      <main className="page">
        {filter.categoryId || filter.month ? (
          <p className="muted">
            Filtered
            {filter.month ? ` · ${filter.month}` : ""}
          </p>
        ) : null}
        {error ? <ErrorState message={error} /> : null}
        {events === null && !error ? <Skeleton rows={6} /> : null}
        {events && events.length === 0 ? <EmptyState title="No movements yet." /> : null}
        {events?.map((event) => {
          const amount = amountOf(event);
          return (
            <article className="event" key={event.id}>
              <div className="row">
                <span className="list-row-title">{titleOf(event)}</span>
                <span className="amount">{amount}</span>
              </div>
              <p className="muted">{metaOf(event)}</p>
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
            </article>
          );
        })}
      </main>
    </>
  );
}
