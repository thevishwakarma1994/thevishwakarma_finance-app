import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { ApiError, fetchTransactionDetail, type TransactionDetailView } from "../apiClient.js";
import { ErrorState, PageHeader, Skeleton } from "../chrome.js";
import { ExpenseCorrectionForm } from "./ExpenseCorrectionForm.js";
import { OtherIncomeCorrectionForm } from "./OtherIncomeCorrectionForm.js";

type Props = {
  eventId: string;
  onBack: () => void;
};

function detailTitle(detail: TransactionDetailView): string {
  if (detail.meaning === "income") {
    return detail.notes ?? "Income";
  }
  return detail.merchant ?? (detail.categories.map((category) => category.name).join(", ") || "Spending");
}

function sideSummary(side: TransactionDetailView["history"][number]["previous"]): string {
  const categories = side.categories.map((category) => category.name).join(", ");
  return [
    formatInr(paise(side.amountPaise)),
    side.accountName,
    categories || null,
    side.merchant,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function TransactionDetail({ eventId, onBack }: Props) {
  const [detail, setDetail] = useState<TransactionDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [correcting, setCorrecting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchTransactionDetail(eventId)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : "Could not load transaction");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eventId, reloadKey]);

  return (
    <>
      <PageHeader title="Transaction" onBack={onBack} />
      <main className="page" data-screen="transaction-detail">
        {loading ? <Skeleton rows={4} /> : null}
        {error ? <ErrorState message={error} /> : null}
        {detail ? (
          <div className="stack">
            <section className="card stack">
              <div className="row">
                <p className="hero-number">{formatInr(paise(detail.amountPaise))}</p>
                {detail.corrected ? <span className="corrected-badge">Corrected</span> : null}
              </div>
              {detail.correctionCount > 0 ? (
                <p className="muted">
                  {detail.correctionCount === 1 ? "1 correction" : `${detail.correctionCount} corrections`}
                </p>
              ) : null}
              <p>{detailTitle(detail)}</p>
              <p className="muted">
                {[detail.occurredOn, detail.accountName, detail.categories.map((category) => category.name).join(", ")]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {detail.notes ? <p>{detail.notes}</p> : null}
            </section>
            {detail.history.length > 0 ? (
              <section className="card stack" data-testid="correction-history">
                <p className="muted">Correction history</p>
                {detail.history.map((step, index) => (
                  <div className="stack" key={`${step.capturedAt}-${index}`}>
                    <p className="muted">{index === 0 ? "Original" : `Correction ${index}`}</p>
                    <p>{sideSummary(step.previous)}</p>
                    <p>→ {sideSummary(step.next)}</p>
                    <p className="muted">
                      {step.capturedAt.slice(0, 10)}
                      {step.reason ? ` · ${step.reason}` : ""}
                    </p>
                  </div>
                ))}
              </section>
            ) : null}
            {detail.canCorrect ? (
              <button className="primary" type="button" onClick={() => setCorrecting(true)}>
                Correct transaction
              </button>
            ) : detail.refusalReason ? (
              <p className="muted">{detail.refusalReason}</p>
            ) : null}
          </div>
        ) : null}
      </main>
      {correcting && detail ? (
        detail.correctionFamily === "other_income" ? (
          <OtherIncomeCorrectionForm
            detail={detail}
            onClose={() => setCorrecting(false)}
            onSaved={() => {
              setCorrecting(false);
              setReloadKey((value) => value + 1);
            }}
          />
        ) : (
          <ExpenseCorrectionForm
            detail={detail}
            onClose={() => setCorrecting(false)}
            onSaved={() => {
              setCorrecting(false);
              setReloadKey((value) => value + 1);
            }}
          />
        )
      ) : null}
    </>
  );
}
