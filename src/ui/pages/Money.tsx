import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  fetchMoney,
  previewOrCommitResolveSurplus,
  type Account,
  type CardListItem,
  type MonthSpend,
  type PendingSurplus,
} from "../apiClient.js";
import { EmptyState, ErrorState, GearIcon, PageHeader, RowChevron, Sheet, Skeleton } from "../chrome.js";

type Props = {
  onOpenMonth: () => void;
  onOpenCard: (cardId: string) => void;
  onOpenAccount: (accountId: string) => void;
  onOpenManage: () => void;
};

export function Money({ onOpenMonth, onOpenCard, onOpenAccount, onOpenManage }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [month, setMonth] = useState<MonthSpend | null>(null);
  const [surplus, setSurplus] = useState<PendingSurplus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [surplusId, setSurplusId] = useState<string | null>(null);
  const [surplusResolution, setSurplusResolution] = useState("");
  const [surplusClaimId, setSurplusClaimId] = useState("");
  const [surplusCycleId, setSurplusCycleId] = useState("");

  function applyMoney(data: Awaited<ReturnType<typeof fetchMoney>>) {
    setAccounts(data.accounts ?? []);
    setMonth(data.month);
    setCards(data.cards ?? []);
    setSurplus(data.surplus ?? []);
  }

  useEffect(() => {
    let cancelled = false;
    void fetchMoney()
      .then((data) => {
        if (cancelled) return;
        applyMoney(data);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught.message : "Could not load Money");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reservedTotal = accounts.reduce((sum, account) => sum + (account.reservedPaise ?? 0), 0);
  const banksTotal = accounts.reduce((sum, account) => sum + account.balancePaise, 0);
  const cardsDue = cards.reduce((sum, card) => sum + card.outstandingPaise, 0);
  const resolving = surplus.find((item) => item.id === surplusId);

  return (
    <>
      <PageHeader
        title="Money"
        trailing={
          <button
            className="header-icon-btn"
            type="button"
            aria-label="Manage money"
            onClick={onOpenManage}
          >
            <GearIcon />
          </button>
        }
      />
      <main className="page" data-screen="money-overview">
        {loading ? <Skeleton rows={5} /> : null}
        {error ? <ErrorState message={error} /> : null}

        <p className="section-label">Banks & cash</p>
        {accounts.length === 0 && !loading ? (
          <EmptyState title="No accounts yet." actionLabel="Add one in Manage" onAction={onOpenManage} />
        ) : null}
        {accounts.map((account) => (
          <button
            className="list-row"
            type="button"
            key={account.id}
            onClick={() => onOpenAccount(account.id)}
          >
            <span className="list-row-copy">
              <span className="list-row-title">{account.displayName}</span>
              <span className="list-row-meta">
                {account.kind === "cash" ? "Cash" : "Bank"}
                {account.isPrimarySalary ? " · Salary" : ""}
                {(account.reservedPaise ?? 0) > 0
                  ? ` · Reserved ${formatInr(paise(account.reservedPaise ?? 0))}`
                  : ""}
              </span>
            </span>
            <span className="amount">{formatInr(paise(account.balancePaise))}</span>
          </button>
        ))}
        {accounts.length > 0 ? (
          <p className="muted">Banks & cash {formatInr(paise(banksTotal))}</p>
        ) : null}

        <p className="section-label">Cards</p>
        {cards.length === 0 && !loading ? (
          <EmptyState title="No cards yet." actionLabel="Add one in Manage" onAction={onOpenManage} />
        ) : null}
        {cards.map((card) => (
          <button className="list-row" type="button" key={card.id} onClick={() => onOpenCard(card.id)}>
            <span className="list-row-copy">
              <span className="list-row-title">{card.label}</span>
              {card.nextDueOn ? <span className="list-row-meta">Due {card.nextDueOn}</span> : null}
            </span>
            <span className="amount">{formatInr(paise(card.outstandingPaise))}</span>
          </button>
        ))}
        {cards.length > 0 ? <p className="muted">To pay {formatInr(paise(cardsDue))}</p> : null}

        {reservedTotal > 0 ? (
          <>
            <p className="section-label">Reserved</p>
            <p className="muted">Reserved {formatInr(paise(reservedTotal))}</p>
            {accounts.flatMap((account) =>
              (account.reservedDetails ?? []).map((detail) => (
                <p className="muted" key={detail.reservationId}>
                  {formatInr(paise(detail.amountPaise))} for {detail.cardLabel}
                  {detail.dueOn ? ` due ${detail.dueOn}` : ""}
                  {detail.personName ? ` · ${detail.personName}` : ""}
                </p>
              )),
            )}
          </>
        ) : null}

        {surplus.length > 0 ? (
          <>
            <p className="section-label">Needs review</p>
            <p className="muted">
              Needs review {formatInr(paise(surplus.reduce((sum, item) => sum + item.amountPaise, 0)))}
            </p>
            {surplus.map((item) => (
              <div className="list-row" key={item.id}>
                <span className="list-row-copy">
                  <span className="list-row-title">{item.explanation}</span>
                  <span className="list-row-meta">
                    {formatInr(paise(item.amountPaise))}
                    {item.personName ? ` · ${item.personName}` : ""}
                  </span>
                </span>
                <button
                  className="secondary compact"
                  type="button"
                  onClick={() => {
                    setSurplusId(item.id);
                    setSurplusResolution(item.resolutions[0] ?? "");
                    setSurplusClaimId(item.openClaims[0]?.id ?? "");
                    setSurplusCycleId(item.unpaidCycles[0]?.id ?? "");
                  }}
                >
                  Resolve
                </button>
              </div>
            ))}
          </>
        ) : null}

        {month ? (
          <>
            <p className="section-label">Monthly summary</p>
            <button className="list-row" type="button" onClick={onOpenMonth}>
              <span className="list-row-copy">
                <span className="list-row-title">This month you spent</span>
                <span className="list-row-meta">Tap for review</span>
              </span>
              <span className="amount">{formatInr(paise(month.spentPaise))}</span>
              <RowChevron />
            </button>
          </>
        ) : null}

        {resolving ? (
          <Sheet title="Resolve surplus" onClose={() => setSurplusId(null)}>
            <form
              className="sheet-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!surplusResolution) return;
                void previewOrCommitResolveSurplus({
                  surplusCaseId: resolving.id,
                  resolution: surplusResolution as
                    | "apply_to_other_claim"
                    | "convert_to_payable"
                    | "treat_as_mine_correction"
                    | "reassign_reservation",
                  claimId: surplusResolution === "apply_to_other_claim" ? surplusClaimId : undefined,
                  billingCycleId: surplusResolution === "reassign_reservation" ? surplusCycleId : undefined,
                  confirmed: surplusResolution === "treat_as_mine_correction" ? true : undefined,
                  commit: true,
                })
                  .then(() => {
                    setSurplusId(null);
                    return fetchMoney().then(applyMoney);
                  })
                  .catch((caught: unknown) => {
                    setError(caught instanceof ApiError ? caught.message : "Could not resolve");
                  });
              }}
            >
              <label>
                Action
                <select
                  value={surplusResolution}
                  onChange={(event) => setSurplusResolution(event.target.value)}
                >
                  {resolving.resolutions.map((resolution) => (
                    <option key={resolution} value={resolution}>
                      {resolution === "apply_to_other_claim"
                        ? "Apply to another claim"
                        : resolution === "convert_to_payable"
                          ? "Convert to payable"
                          : resolution === "treat_as_mine_correction"
                            ? "Treat as mine"
                            : "Reassign reservation"}
                    </option>
                  ))}
                </select>
              </label>
              {surplusResolution === "apply_to_other_claim" ? (
                <label>
                  Claim
                  <select value={surplusClaimId} onChange={(event) => setSurplusClaimId(event.target.value)}>
                    {resolving.openClaims.map((claim) => (
                      <option key={claim.id} value={claim.id}>
                        {claim.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {surplusResolution === "reassign_reservation" ? (
                <label>
                  Cycle
                  <select value={surplusCycleId} onChange={(event) => setSurplusCycleId(event.target.value)}>
                    {resolving.unpaidCycles.map((cycle) => (
                      <option key={cycle.id} value={cycle.id}>
                        {cycle.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {surplusResolution === "treat_as_mine_correction" ? (
                <p className="danger">This will treat this amount as your money. It is not recorded as income.</p>
              ) : null}
              <button className="primary" type="submit">
                Confirm resolution
              </button>
              <button className="secondary" type="button" onClick={() => setSurplusId(null)}>
                Cancel
              </button>
            </form>
          </Sheet>
        ) : null}
      </main>
    </>
  );
}
