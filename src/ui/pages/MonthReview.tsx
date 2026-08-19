import { useEffect, useState } from "react";
import { formatInr, formatInrDelta } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchMonthReview, type MonthReview as MonthReviewData } from "../apiClient.js";
import { ErrorState, PageHeader, RowChevron, Skeleton } from "../chrome.js";

type Props = {
  onOpenActivity: (href: string) => void;
  onBack: () => void;
};

export function MonthReview({ onOpenActivity, onBack }: Props) {
  const [review, setReview] = useState<MonthReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMonthReview()
      .then(setReview)
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load month review");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  return (
    <>
      <PageHeader title="Month Review" onBack={onBack} />
      <main className="page" data-screen="month-review">
        {loading ? <Skeleton rows={4} /> : null}
        {error ? <ErrorState message={error} /> : null}

        {review ? (
          <>
            <section className="card stack">
              <div>
                <p className="muted">Personal spending · {review.month}</p>
                <p className="hero-number">{formatInr(paise(review.spentPaise))}</p>
              </div>
              <div className="row">
                <span className="muted">Previous month {review.previousMonth}</span>
                <span>{formatInr(paise(review.previousSpentPaise))}</span>
              </div>
              <div className="row">
                <span className="muted">vs last month</span>
                <strong>{formatInrDelta(paise(review.differencePaise))}</strong>
              </div>
            </section>

            <p className="section-label">Categories</p>
            {review.categories.map((category) => (
              <button
                className="list-row"
                type="button"
                key={category.categoryId}
                onClick={() =>
                  onOpenActivity(
                    `/activity?categoryId=${encodeURIComponent(category.categoryId)}&month=${encodeURIComponent(review.month)}`,
                  )
                }
              >
                <span className="list-row-main">
                  <span className="list-row-copy">
                    <span className="list-row-title">{category.name}</span>
                    <span className="list-row-meta">See activity</span>
                  </span>
                </span>
                <span className="amount">{formatInr(paise(category.spentPaise))}</span>
                <RowChevron />
              </button>
            ))}
          </>
        ) : null}
      </main>
    </>
  );
}
