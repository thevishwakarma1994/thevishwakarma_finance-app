import { useEffect, useState, type FormEvent } from "react";
import { parseInr } from "../../domain/money/inr.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  fetchComingCardPayments,
  fetchAccounts,
  fetchCards,
  fetchCategories,
  fetchPeople,
  previewOrCommitBorrow,
  previewOrCommitCardSpend,
  previewOrCommitExpense,
  previewOrCommitIncome,
  previewOrCommitLend,
  previewOrCommitPayCard,
  previewOrCommitPaySettlement,
  previewOrCommitReceiveSettlement,
  previewOrCommitSplit,
  previewOrCommitTransfer,
  fetchSettlementSuggestion,
  type Account,
  type CardListItem,
  type Category,
  type ComingCardPayment,
  type ConsequencePreview,
  type PersonListItem,
} from "../apiClient.js";

type Intent = "income" | "expense" | "transfer" | "card_spend" | "pay_card" | "split" | "lend" | "borrow" | "settlement_in" | "settlement_out" | null;
type CardOwnership = "mine" | "theirs" | "split";

type Props = {
  onDone: () => void;
};

export function Add({ onDone }: Props) {
  const [intent, setIntent] = useState<Intent>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [coming, setComing] = useState<ComingCardPayment[]>([]);
  const [accountId, setAccountId] = useState("");
  const [toAccountId, setToAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [cardId, setCardId] = useState("");
  const [cycleId, setCycleId] = useState("");
  const [personId, setPersonId] = useState("");
  const [ownership, setOwnership] = useState<CardOwnership>("mine");
  const [ownerPersonId, setOwnerPersonId] = useState("");
  const [splitSource, setSplitSource] = useState<"account" | "card">("account");
  const [userShare, setUserShare] = useState("");
  const [personShareRows, setPersonShareRows] = useState<{ personId: string; amount: string }[]>([
    { personId: "", amount: "" },
  ]);
  const [settlementRows, setSettlementRows] = useState<{ claimId: string; label: string; openPaise: number; amount: string }[]>([]);
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState<string>(todayKolkata());
  const [kind, setKind] = useState<"salary" | "other">("salary");
  const [merchant, setMerchant] = useState("");
  const [preview, setPreview] = useState<ConsequencePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedCard = cards.find((card) => card.id === cardId);
  const payableCycles = coming.filter((item) => item.cardId === cardId);
  const activePeople = people.filter((person) => person.status === "active");
  const defaultOwnerName = selectedCard?.defaultOwnerName;
  const showDefaultOwnerWarning =
    intent === "card_spend" &&
    ownership === "theirs" &&
    Boolean(selectedCard?.defaultOwnerPersonId) &&
    ownerPersonId === selectedCard?.defaultOwnerPersonId;

  function applyCardDefault(card: CardListItem | undefined) {
    if (card?.defaultOwnerPersonId) {
      setOwnership("theirs");
      setOwnerPersonId(card.defaultOwnerPersonId);
    } else {
      setOwnership("mine");
      setOwnerPersonId("");
    }
  }

  useEffect(() => {
    Promise.all([
      fetchAccounts(),
      fetchCategories(),
      fetchCards(),
      fetchComingCardPayments(),
      fetchPeople(),
    ])
      .then(([accountData, categoryData, cardData, comingData, peopleData]) => {
        setAccounts(accountData.accounts);
        setCategories(categoryData.categories);
        setCards(cardData.cards);
        setComing(comingData.items);
        setPeople(peopleData.people);
        setAccountId(accountData.accounts[0]?.id ?? "");
        setToAccountId(accountData.accounts[1]?.id ?? accountData.accounts[0]?.id ?? "");
        setCategoryId(categoryData.categories[0]?.id ?? "");
        const firstPerson = peopleData.people.find((person) => person.status === "active");
        setPersonId(firstPerson?.id ?? "");
        setPersonShareRows([{ personId: firstPerson?.id ?? "", amount: "" }]);
        const firstCard = cardData.cards[0];
        setCardId(firstCard?.id ?? "");
        const firstPayable = comingData.items.find((item) => item.cardId === firstCard?.id);
        setCycleId(firstPayable?.cycleId ?? firstCard?.currentCycle?.id ?? "");
        if (firstCard?.defaultPaymentAccountId) {
          setAccountId(firstCard.defaultPaymentAccountId);
        }
        applyCardDefault(firstCard);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load form");
      });
  }, []);

  async function runCommand(commit: boolean) {
    const amountPaise = parseInr(amount);
    if (intent === "income") {
      return previewOrCommitIncome({ occurredOn, amountPaise, accountId, kind, commit });
    }
    if (intent === "transfer") {
      return previewOrCommitTransfer({
        occurredOn,
        amountPaise,
        fromAccountId: accountId,
        toAccountId,
        commit,
      });
    }
    if (intent === "pay_card") {
      return previewOrCommitPayCard({
        occurredOn,
        creditCardId: cardId,
        billingCycleId: cycleId,
        accountId,
        amountPaise,
        commit,
      });
    }
    if (intent === "lend") {
      return previewOrCommitLend({ occurredOn, accountId, personId, amountPaise, commit });
    }
    if (intent === "borrow") {
      return previewOrCommitBorrow({ occurredOn, accountId, personId, amountPaise, commit });
    }
    if (intent === "settlement_in" || intent === "settlement_out") {
      const allocations = settlementRows
        .filter((row) => row.claimId && row.amount.trim())
        .map((row) => ({ claimId: row.claimId, amountPaise: parseInr(row.amount) }));
      const body = { occurredOn, accountId, personId, amountPaise, allocations, commit };
      return intent === "settlement_in"
        ? previewOrCommitReceiveSettlement(body)
        : previewOrCommitPaySettlement(body);
    }
    if (intent === "split" || (intent === "card_spend" && ownership === "split")) {
      const personShares = personShareRows
        .filter((row) => row.personId && row.amount.trim())
        .map((row) => ({ personId: row.personId, amountPaise: parseInr(row.amount) }));
      const userSharePaise = userShare.trim() ? parseInr(userShare) : 0;
      return previewOrCommitSplit({
        occurredOn,
        amountPaise,
        source:
          intent === "card_spend" || splitSource === "card"
            ? { type: "card", creditCardId: cardId }
            : { type: "account", accountId },
        userSharePaise,
        personShares,
        allocations:
          userSharePaise > 0 ? [{ categoryId, amountPaise: userSharePaise }] : [],
        merchant: merchant.trim() || null,
        commit,
      });
    }
    if (intent === "card_spend") {
      if (ownership === "theirs") {
        return previewOrCommitCardSpend({
          occurredOn,
          creditCardId: cardId,
          allocations: [],
          amountPaise,
          ownerPersonId,
          merchant: merchant.trim() || null,
          commit,
        });
      }
      return previewOrCommitCardSpend({
        occurredOn,
        creditCardId: cardId,
        allocations: [{ categoryId, amountPaise }],
        ownerPersonId: null,
        merchant: merchant.trim() || null,
        commit,
      });
    }
    return previewOrCommitExpense({
      occurredOn,
      accountId,
      allocations: [{ categoryId, amountPaise }],
      merchant: merchant.trim() || null,
      commit,
    });
  }

  async function onPreview(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await runCommand(false);
      setPreview(result.preview);
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
      await runCommand(true);
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
          <button className="secondary" type="button" onClick={() => setIntent("split")}>
            We split something
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("lend")}>
            I lent money
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("borrow")}>
            I borrowed money
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("settlement_in")}>
            They paid me
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("settlement_out")}>
            I paid them
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
            {preview.warnings.map((line) => (
              <p key={line} className="danger">
                {line}
              </p>
            ))}
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
            : intent === "split"
              ? "We split something"
              : intent === "lend"
                ? "I lent money"
                : intent === "borrow"
                  ? "I borrowed money"
                  : intent === "settlement_in"
                    ? "They paid me"
                    : intent === "settlement_out"
                      ? "I paid them"
                  : "I spent money";

  const showSplitFields = intent === "split" || (intent === "card_spend" && ownership === "split");
  const showCategory =
    intent === "expense" ||
    (intent === "card_spend" && ownership === "mine") ||
    (showSplitFields && Boolean(userShare.trim()));

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
          {intent === "card_spend" || intent === "pay_card" || (intent === "split" && splitSource === "card") ? (
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
                  if (intent === "card_spend") applyCardDefault(card);
                }}
              >
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {card.label}
                  </option>
                ))}
              </select>
            </label>
          ) : intent !== "split" || splitSource === "account" ? (
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
          ) : null}
          {intent === "card_spend" ? (
            <label>
              Whose purchase
              <select
                value={ownership}
                onChange={(event) => setOwnership(event.target.value as CardOwnership)}
              >
                <option value="mine">Mine</option>
                <option value="theirs">Someone else's</option>
                <option value="split">Split</option>
              </select>
            </label>
          ) : null}
          {intent === "card_spend" && ownership === "theirs" ? (
            <label>
              Owner
              <select value={ownerPersonId} onChange={(event) => setOwnerPersonId(event.target.value)}>
                {activePeople.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {showDefaultOwnerWarning ? (
            <p className="danger">This purchase is {defaultOwnerName}'s by default</p>
          ) : null}
          {intent === "split" ? (
            <label>
              Paid from
              <select
                value={splitSource}
                onChange={(event) => setSplitSource(event.target.value as "account" | "card")}
              >
                <option value="account">Bank / cash</option>
                <option value="card">Credit card</option>
              </select>
            </label>
          ) : null}
          {showSplitFields ? (
            <>
              <label>
                Your share (INR)
                <input
                  inputMode="decimal"
                  value={userShare}
                  onChange={(event) => setUserShare(event.target.value)}
                />
              </label>
              {personShareRows.map((row, index) => (
                <div className="stack" key={`share-${index}`}>
                  <label>
                    Person
                    <select
                      value={row.personId}
                      onChange={(event) => {
                        const next = [...personShareRows];
                        const current = next[index];
                        if (!current) return;
                        next[index] = { ...current, personId: event.target.value };
                        setPersonShareRows(next);
                      }}
                    >
                      <option value="">Select</option>
                      {activePeople.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Their share (INR)
                    <input
                      inputMode="decimal"
                      value={row.amount}
                      onChange={(event) => {
                        const next = [...personShareRows];
                        const current = next[index];
                        if (!current) return;
                        next[index] = { ...current, amount: event.target.value };
                        setPersonShareRows(next);
                      }}
                    />
                  </label>
                </div>
              ))}
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  setPersonShareRows([
                    ...personShareRows,
                    { personId: activePeople[0]?.id ?? "", amount: "" },
                  ])
                }
              >
                Add person
              </button>
            </>
          ) : null}
          {intent === "lend" || intent === "borrow" || intent === "settlement_in" || intent === "settlement_out" ? (
            <label>
              Person
              <select
                value={personId}
                onChange={(event) => {
                  setPersonId(event.target.value);
                  setSettlementRows([]);
                }}
              >
                {activePeople.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {intent === "settlement_in" || intent === "settlement_out" ? (
            <>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  if (!personId || !amount.trim()) return;
                  void fetchSettlementSuggestion(
                    personId,
                    parseInr(amount),
                    intent === "settlement_in" ? "they_owe_user" : "user_owes_them",
                  )
                    .then((data) => {
                      const byId = new Map(data.allocations.map((item) => [item.claimId, item.amountPaise]));
                      setSettlementRows(
                        data.claims.map((claim) => ({
                          claimId: claim.id,
                          label: claim.label,
                          openPaise: claim.openAmountPaise,
                          amount: ((byId.get(claim.id) ?? 0) / 100).toString(),
                        })),
                      );
                    })
                    .catch((caught: unknown) => {
                      setError(caught instanceof Error ? caught.message : "Could not suggest allocations");
                    });
                }}
              >
                Suggest allocation
              </button>
              {settlementRows.map((row, index) => (
                <label key={row.claimId}>
                  {row.label} (open {(row.openPaise / 100).toFixed(2)})
                  <input
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(event) => {
                      const next = [...settlementRows];
                      const current = next[index];
                      if (!current) return;
                      next[index] = { ...current, amount: event.target.value };
                      setSettlementRows(next);
                    }}
                  />
                </label>
              ))}
              <p className="muted">Review which claims this will reduce before continuing.</p>
            </>
          ) : null}
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
          ) : showCategory ? (
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
          ) : intent === "card_spend" && ownership === "theirs" ? (
            <label>
              Merchant (optional)
              <input value={merchant} onChange={(event) => setMerchant(event.target.value)} />
            </label>
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
