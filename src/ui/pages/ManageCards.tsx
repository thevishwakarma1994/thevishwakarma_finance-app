import { useEffect, useState, type FormEvent } from "react";
import { parseInr } from "../../domain/money/inr.js";
import {
  ApiError,
  createCard,
  fetchAccounts,
  fetchCards,
  fetchPeople,
  updateCard,
  type Account,
  type CardListItem,
  type PersonListItem,
} from "../apiClient.js";
import { PageHeader, Sheet } from "../chrome.js";

type Props = {
  onBack: () => void;
};

export function ManageCards({ onBack }: Props) {
  const [cards, setCards] = useState<CardListItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CardListItem | null>(null);
  const [newCardName, setNewCardName] = useState("");
  const [newCardIssuer, setNewCardIssuer] = useState("");
  const [newCardMask, setNewCardMask] = useState("");
  const [newCardStatementDay, setNewCardStatementDay] = useState("12");
  const [newCardDueDays, setNewCardDueDays] = useState("18");
  const [newCardLimit, setNewCardLimit] = useState("");
  const [newCardPaymentAccountId, setNewCardPaymentAccountId] = useState("");
  const [newCardOwnerPersonId, setNewCardOwnerPersonId] = useState("");
  const [editName, setEditName] = useState("");
  const [editOwnerPersonId, setEditOwnerPersonId] = useState("");

  function load() {
    return Promise.all([fetchCards(), fetchAccounts(), fetchPeople()]).then(
      ([cardData, accountData, peopleData]) => {
        setCards(cardData.cards);
        setAccounts(accountData.accounts);
        setPeople(peopleData.people);
        if (accountData.accounts[0]) {
          setNewCardPaymentAccountId((current) => current || accountData.accounts[0]?.id || "");
        }
      },
    );
  }

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load cards");
    });
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createCard({
        displayName: newCardName,
        issuer: newCardIssuer || newCardName,
        mask: newCardMask || null,
        statementDay: Number(newCardStatementDay),
        dueDaysAfterStatement: Number(newCardDueDays),
        creditLimitPaise: newCardLimit ? parseInr(newCardLimit) : null,
        defaultPaymentAccountId: newCardPaymentAccountId || null,
        defaultOwnerPersonId: newCardOwnerPersonId || null,
      });
      setNewCardName("");
      setNewCardIssuer("");
      setNewCardMask("");
      setNewCardLimit("");
      setAdding(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create card");
    }
  }

  return (
    <>
      <PageHeader
        title="Cards"
        onBack={onBack}
        trailing={
          <button className="header-btn trailing" type="button" onClick={() => setAdding(true)}>
            Add
          </button>
        }
      />
      <main className="page" data-screen="manage-cards">
        <p className="page-lead muted">Statement day, due dates, and who usually owns spend.</p>
        {error ? <p className="danger">{error}</p> : null}
        {cards.length === 0 ? <p className="muted">No cards yet.</p> : null}
        {cards.map((card) => (
          <button
            className="list-row"
            type="button"
            key={card.id}
            onClick={() => {
              setEditing(card);
              setEditName(card.displayName);
              setEditOwnerPersonId(card.defaultOwnerPersonId ?? "");
            }}
          >
            <span className="list-row-copy">
              <span className="list-row-title">{card.label}</span>
              <span className="muted">
                Statement day {card.statementDay} · due +{card.dueDaysAfterStatement}
              </span>
            </span>
            <span aria-hidden="true">···</span>
          </button>
        ))}
      </main>
      {adding ? (
        <Sheet
          title="Add card"
          tall
          onClose={() => setAdding(false)}
          footer={
            <button className="primary" type="submit" form="add-card-form">
              Create card
            </button>
          }
        >
          <form id="add-card-form" className="sheet-form" onSubmit={(event) => void onCreate(event)}>
            <label>
              Name
              <input value={newCardName} onChange={(event) => setNewCardName(event.target.value)} required />
            </label>
            <label>
              Issuer
              <input value={newCardIssuer} onChange={(event) => setNewCardIssuer(event.target.value)} />
            </label>
            <label>
              Last 4
              <input
                value={newCardMask}
                onChange={(event) => setNewCardMask(event.target.value)}
                inputMode="numeric"
                maxLength={4}
              />
            </label>
            <label>
              Statement day
              <input
                value={newCardStatementDay}
                onChange={(event) => setNewCardStatementDay(event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              Days after statement until due
              <input
                value={newCardDueDays}
                onChange={(event) => setNewCardDueDays(event.target.value)}
                inputMode="numeric"
                required
              />
            </label>
            <label>
              Credit limit (optional)
              <input
                inputMode="decimal"
                value={newCardLimit}
                onChange={(event) => setNewCardLimit(event.target.value)}
              />
            </label>
            <label>
              Pays from
              <select
                value={newCardPaymentAccountId}
                onChange={(event) => setNewCardPaymentAccountId(event.target.value)}
              >
                <option value="">None</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Default owner
              <select
                value={newCardOwnerPersonId}
                onChange={(event) => setNewCardOwnerPersonId(event.target.value)}
              >
                <option value="">You</option>
                {people
                  .filter((person) => person.status === "active")
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </label>
          </form>
        </Sheet>
      ) : null}
      {editing ? (
        <Sheet
          title="Edit card"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="primary" type="submit" form="edit-card-form">
                Save
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void updateCard({ cardId: editing.id, status: "inactive" })
                    .then(() => {
                      setEditing(null);
                      return load();
                    })
                    .catch((caught: unknown) => {
                      setError(caught instanceof ApiError ? caught.message : "Could not archive");
                    })
                }
              >
                Archive
              </button>
            </>
          }
        >
          <form
            id="edit-card-form"
            className="sheet-form"
            onSubmit={(event) => {
              event.preventDefault();
              void updateCard({
                cardId: editing.id,
                displayName: editName,
                defaultOwnerPersonId: editOwnerPersonId || null,
              })
                .then(() => {
                  setEditing(null);
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not save");
                });
            }}
          >
            <label>
              Name
              <input value={editName} onChange={(event) => setEditName(event.target.value)} />
            </label>
            <label>
              Default owner
              <select value={editOwnerPersonId} onChange={(event) => setEditOwnerPersonId(event.target.value)}>
                <option value="">You</option>
                {people
                  .filter((person) => person.status === "active")
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
              </select>
            </label>
          </form>
        </Sheet>
      ) : null}
    </>
  );
}
