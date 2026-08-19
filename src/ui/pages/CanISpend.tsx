import { useEffect, useState, type FormEvent } from "react";
import { formatInr, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  fetchAccounts,
  fetchCards,
  fetchHome,
  simulateAffordability,
  type Account,
  type AffordabilityView,
  type CardListItem,
  type HomeView,
} from "../apiClient.js";
import { cacheHomeView, getCachedHomeView } from "../homeCache.js";
import { PageHeader } from "../chrome.js";

type Props = {
  onBack: () => void;
};

export function CanISpend({ onBack }: Props) {
  const [home, setHome] = useState<HomeView | null>(() => getCachedHomeView());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<"account" | "card">("account");
  const [accountId, setAccountId] = useState("");
  const [cardId, setCardId] = useState("");
  const [result, setResult] = useState<AffordabilityView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cached = getCachedHomeView();
    const homePromise = cached
      ? Promise.resolve(cached)
      : fetchHome().then((view) => {
          cacheHomeView(view);
          return view;
        });
    Promise.all([homePromise, fetchAccounts(), fetchCards()])
      .then(([homeData, accountData, cardData]) => {
        setHome(homeData);
        setAccounts(accountData.accounts);
        setCards(cardData.cards);
        setAccountId(accountData.accounts[0]?.id ?? "");
        setCardId(cardData.cards[0]?.id ?? "");
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load");
      });
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const amountPaise = parseInr(amount);
    if (amountPaise === null || amountPaise <= 0) {
      setError("Enter an amount");
      return;
    }
    setError(null);
    void simulateAffordability({
      amountPaise,
      funding: source === "account" ? { accountId } : { creditCardId: cardId },
    })
      .then(setResult)
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not simulate");
      });
  }

  return (
    <>
      <PageHeader title="Can I spend this?" onBack={onBack} />
      <main className="page">
      {error ? <p className="danger">{error}</p> : null}
      {home ? (
        <p className="muted">Safe to spend now {formatInr(paise(home.currentCycleSafeToSpend))}</p>
      ) : null}
      <form className="stack" onSubmit={onSubmit}>
        <label>
          Amount
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
        </label>
        <label>
          Pay from
          <select value={source} onChange={(event) => setSource(event.target.value as "account" | "card")}>
            <option value="account">Bank / cash</option>
            <option value="card">Card</option>
          </select>
        </label>
        {source === "account" ? (
          <label>
            Account
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Card
            <select value={cardId} onChange={(event) => setCardId(event.target.value)}>
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="primary" type="submit">
          Check
        </button>
      </form>
      {result ? (
        <section className="card stack">
          <div className="row">
            <span>After this</span>
            <strong>{formatInr(paise(result.afterCurrent.currentCycleSafeToSpend))}</strong>
          </div>
          <div className="row">
            <span>Worst later period</span>
            <strong>{formatInr(paise(result.worstProjectedSafeToSpend))}</strong>
          </div>
          <p>
            <strong>
              {result.conclusion.code === "comfortable"
                ? "This looks comfortable"
                : result.conclusion.code === "tight"
                  ? "This is tight"
                  : "Better not spend this"}
            </strong>
          </p>
          {result.conclusion.reasons.map((reason) => (
            <p key={reason} className="muted">
              {reason}
            </p>
          ))}
        </section>
      ) : null}
    </main>
    </>
  );
}
