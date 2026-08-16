import { useEffect, useState, type FormEvent } from "react";
import { parseInr } from "../../domain/money/inr.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  fetchComingCardPayments,
  fetchAccounts,
  fetchCards,
  fetchCategories,
  previewOrCommitCardSpend,
  previewOrCommitExpense,
  previewOrCommitIncome,
  previewOrCommitPayCard,
  previewOrCommitTransfer,
  type Account,
  type CardListItem,
  type Category,
  type ComingCardPayment,
  type ConsequencePreview,
} from "../apiClient.js";

type Intent = "income" | "expense" | "transfer" | "card_spend" | "pay_card" | null;

type Props = {
  onDone: () => void;
};

export function Add({ onDone }: Props) {
  const [intent, setIntent] = useState<Intent>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [coming, setComing] = useState<ComingCardPayment[]>([]);
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [cardId, setCardId] = useState("");
  const [cycleId, setCycleId] = useState("");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState<string>(todayKolkata());
  const [kind, setKind] = useState<"salary" | "other">("salary");
  const [merchant, setMerchant] = useState("");
  const [preview, setPreview] = useState<ConsequencePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedCard = cards.find((card) => card.id === cardId);
  const payableCycles = coming.filter((item) => item.cardId === cardId);

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchCategories(), fetchCards(), fetchComingCardPayments()])
      .then(([accountData, categoryData, cardData, comingData]) => {
        setAccounts(accountData.accounts);
        setCategories(categoryData.categories);
        setCards(cardData.cards);
        setComing(comingData.items);
        setAccountId(accountData.accounts[0]?.id ?? "");
        setToAccountId(accountData.accounts[1]?.id ?? accountData.accounts[0]?.id ?? "");
        setCategoryId(categoryData.categories[0]?.id ?? "");
        const firstCard = cardData.cards[0];
        setCardId(firstCard?.id ?? "");
        const firstPayable = comingData.items.find((item) => item.cardId === firstCard?.id);
        setCycleId(firstPayable?.cycleId ?? firstCard?.currentCycle?.id ?? "");
        if (firstCard?.defaultPaymentAccountId) {
          setAccountId(firstCard.defaultPaymentAccountId);
        }
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load form");
      });
  }, []);

  async function onPreview(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const amountPaise = parseInr(amount);
      if (intent === "income") {
        const result = await previewOrCommitIncome({
          occurredOn,
          amountPaise,
          accountId,
          kind,
          commit: false,
        });
        setPreview(result.preview);
      } else if (intent === "transfer") {
        const result = await previewOrCommitTransfer({
          occurredOn,
          amountPaise,
          fromAccountId: accountId,
          toAccountId,
          commit: false,
        });
        setPreview(result.preview);
      } else if (intent === "card_spend") {
        const result = await previewOrCommitCardSpend({
          occurredOn,
          creditCardId: cardId,
          allocations: [{ categoryId, amountPaise }],
          merchant: merchant.trim() || null,
          commit: false,
        });
        setPreview(result.preview);
      } else if (intent === "pay_card") {
        const result = await previewOrCommitPayCard({
          occurredOn,
          creditCardId: cardId,
          billingCycleId: cycleId,
          accountId,
          amountPaise,
          commit: false,
        });
        setPreview(result.preview);
      } else {
        const result = await previewOrCommitExpense({
          occurredOn,
          accountId,
          allocations: [{ categoryId, amountPaise }],
          merchant: merchant.trim() || null,
          commit: false,
        });
        setPreview(result.preview);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not preview");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      const amountPaise = parseInr(amount);
      if (intent === "income") {
        await previewOrCommitIncome({
          occurredOn,
          amountPaise,
          accountId,
          kind,
          commit: true,
        });
      } else if (intent === "transfer") {
        await previewOrCommitTransfer({
          occurredOn,
          amountPaise,
          fromAccountId: accountId,
          toAccountId,
          commit: true,
        });
      } else if (intent === "card_spend") {
        await previewOrCommitCardSpend({
          occurredOn,
          creditCardId: cardId,
          allocations: [{ categoryId, amountPaise }],
          merchant: merchant.trim() || null,
          commit: true,
        });
      } else if (intent === "pay_card") {
        await previewOrCommitPayCard({
          occurredOn,
          creditCardId: cardId,
          billingCycleId: cycleId,
          accountId,
          amountPaise,
          commit: true,
        });
      } else {
        await previewOrCommitExpense({
          occurredOn,
          accountId,
          allocations: [{ categoryId, amountPaise }],
          merchant: merchant.trim() || null,
          commit: true,
        });
      }
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!intent) {
    return (
      <>
        <header className="header">
          <h1>Add</h1>
        </header>
        <main className="page choice">
          <button className="primary" type="button" onClick={() => setIntent("income")}>
            I got paid
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("expense")}>
            I spent money
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("card_spend")}>
            Card spend
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("pay_card")}>
            I paid a card
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("transfer")}>
            Move money
          </button>
        </main>
      </>
    );
  }

  if (preview) {
    return (
      <>
        <header className="header">
          <h1>Check this first</h1>
        </header>
        <main className="page">
          <section className="card preview">
            {preview.narrative.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
          {error ? <p className="danger">{error}</p> : null}
          <div className="stack">
            <button className="primary" type="button" disabled={busy} onClick={() => void onConfirm()}>
              Save
            </button>
            <button className="secondary" type="button" onClick={() => setPreview(null)}>
              Back
            </button>
          </div>
        </main>
      </>
    );
  }

  const title =
    intent === "income"
      ? "I got paid"
      : intent === "transfer"
        ? "Move money"
        : intent === "card_spend"
          ? "Card spend"
          : intent === "pay_card"
            ? "I paid a card"
            : "I spent money";

  return (
    <>
      <header className="header">
        <h1>{title}</h1>
      </header>
      <main className="page">
        <form className="card stack" onSubmit={onPreview}>
          <label>
            Amount (INR)
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          {intent === "card_spend" || intent === "pay_card" ? (
            <label>
              Card
              <select
                value={cardId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setCardId(nextId);
                  const card = cards.find((item) => item.id === nextId);
                  const firstPayable = coming.find((item) => item.cardId === nextId);
                  setCycleId(firstPayable?.cycleId ?? card?.currentCycle?.id ?? "");
                  if (card?.defaultPaymentAccountId) {
                    setAccountId(card.defaultPaymentAccountId);
                  }
                }}
              >
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {intent === "transfer" ? "From" : "Account"}
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {intent === "pay_card" ? (
            <>
              <label>
                Cycle
                <select value={cycleId} onChange={(event) => setCycleId(event.target.value)}>
                  {payableCycles.length > 0 ? (
                    payableCycles.map((item) => (
                      <option key={item.cycleId} value={item.cycleId}>
                        Due {item.dueOn}
                      </option>
                    ))
                  ) : selectedCard?.currentCycle ? (
                    <option value={selectedCard.currentCycle.id}>
                      Statement {selectedCard.currentCycle.expectedStatementOn}
                    </option>
                  ) : (
                    <option value="">No open cycle</option>
                  )}
                </select>
              </label>
              <label>
                Pay from
                <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {intent === "transfer" ? (
            <label>
              To
              <select value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {intent === "income" ? (
            <label>
              Kind
              <select value={kind} onChange={(event) => setKind(event.target.value as "salary" | "other")}>
                <option value="salary">Salary</option>
                <option value="other">Other income</option>
              </select>
            </label>
          ) : intent === "expense" || intent === "card_spend" ? (
            <>
              <label>
                Category
                <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Merchant (optional)
                <input value={merchant} onChange={(event) => setMerchant(event.target.value)} />
              </label>
            </>
          ) : null}
          <label>
            Date
            <input type="date" value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} />
          </label>
          {error ? <p className="danger">{error}</p> : null}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Checking…" : "See what this will do"}
          </button>
          <button className="secondary" type="button" onClick={() => setIntent(null)}>
            Cancel
          </button>
        </form>
      </main>
    </>
  );
}
