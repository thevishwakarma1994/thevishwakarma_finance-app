import { useEffect, useState } from "react";
import { formatInr, formatInrDelta } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchMonthReview, type MonthReview as MonthReviewData } from "../apiClient.js";

type Props = {
  onOpenActivity: (href: string) => void;
};

export function MonthReview({ onOpenActivity }: Props) {
  const [review, setReview] = useState<MonthReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMonthReview()
      .then(setReview)
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load month review");
      });
  }, []);

  return (
    <>
      <header className="header">
        <h1>Month Review</h1>
      </header>
      <main className="page">
        {review ? (
          <>
            <section className="card">
              <p className="muted">Personal spending · {review.month}</p>
              <p className="balance">{formatInr(paise(review.spentPaise))}</p>
              <p className="muted">
                Previous month {review.previousMonth}: {formatInr(paise(review.previousSpentPaise))}
              </p>
              <p>
                vs last month {formatInrDelta(paise(review.differencePaise))}
              </p>
            </section>
            {review.categories.map((category) => (
              <button
                className="card link-card"
                type="button"
                key={category.categoryId}
                onClick={() =>
                  onOpenActivity(
                    `/activity?categoryId=${encodeURIComponent(category.categoryId)}&month=${encodeURIComponent(review.month)}`,
                  )
                }
              >
                <div className="row">
                  <strong>{category.name}</strong>
                  <span>{formatInr(paise(category.spentPaise))}</span>
                </div>
                <p className="muted">See activity</p>
              </button>
            ))}
          </>
        ) : null}
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
