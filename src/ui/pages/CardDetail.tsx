import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  fetchCard,
  fetchPeople,
  fetchAccounts,
  updateCard,
  type ActivityEvent,
  type CardCycleView,
  type PersonListItem,
  type Account,
} from "../apiClient.js";
import { ErrorState, PageHeader, Sheet, Skeleton } from "../chrome.js";
import { OverflowIcon } from "../icons.js";
import type { AddIntent } from "./Add.js";
import { OpeningCardDebtForm, OpeningEarmarkForm } from "../components/OpeningForms.js";

type Props = {
  cardId: string;
  onBack: () => void;
  onOpenCycle: (cycleId: string) => void;
  onCapture: (
    intent: Extract<AddIntent, "card_spend" | "pay_card">,
    defaults: { cardId: string; cycleId?: string },
  ) => void;
};

export function CardDetail({ cardId, onBack, onOpenCycle, onCapture }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openingFormOpen, setOpeningFormOpen] = useState(false);
  const [rename, setRename] = useState("");
  const [ownerPersonId, setOwnerPersonId] = useState("");
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [data, setData] = useState<{
    displayName: string;
    issuer: string;
    label: string;
    mask: string | null;
    outstandingPaise: number;
    statementDay: number;
    dueDaysAfterStatement: number;
    defaultOwnerPersonId: string | null;
    defaultOwnerName: string | null;
    cycles: CardCycleView[];
    transactions: ActivityEvent[];
  } | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [earmarkFormOpen, setEarmarkFormOpen] = useState(false);

  useEffect(() => {
    Promise.all([fetchCard(cardId), fetchPeople(), fetchAccounts()])
      .then(([card, peopleData, accountsData]) => {
        setData(card);
        setRename(card.displayName);
        setOwnerPersonId(card.defaultOwnerPersonId ?? "");
        setPeople(peopleData.people);
        setAccounts(accountsData.accounts);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load card");
      });
  }, [cardId]);

  const dueCycle =
    data?.cycles.find((cycle) => cycle.remainingPaise > 0) ?? data?.cycles[0] ?? null;

  return (
    <>
      <PageHeader
        title={data?.label ?? "Card"}
        onBack={onBack}
        trailing={
          <button className="header-icon-btn" type="button" aria-label="More" onClick={() => setMenuOpen(true)}>
            <OverflowIcon />
          </button>
        }
      />
      <main className="page" data-screen="card-detail">
        {error ? <ErrorState message={error} /> : null}
        {!data && !error ? (
          <Skeleton rows={4} />
        ) : data ? (
          <>
            <p className="muted">To pay the card</p>
            <p className="hero-number">{formatInr(paise(data.outstandingPaise))}</p>
            {dueCycle ? <p className="muted">Due {dueCycle.dueOn}</p> : null}
            <div className="stack">
              {data.outstandingPaise > 0 ? (
                <button
                  className="primary"
                  type="button"
                  onClick={() =>
                    onCapture("pay_card", { cardId, cycleId: dueCycle?.id })
                  }
                >
                  Pay this card
                </button>
              ) : null}
              <button
                className={data.outstandingPaise > 0 ? "secondary" : "primary"}
                type="button"
                onClick={() => onCapture("card_spend", { cardId, cycleId: dueCycle?.id })}
              >
                Add purchase
              </button>
              
              {(() => {
                const hasNormal = data.transactions.some(t => !t.meaning.includes("opening"));
                const baseEvent = data.transactions.find(t => t.meaning === "apply_opening_card_position");
                const resEvent = data.transactions.find(t => t.meaning === "apply_opening_reservation");
                const buttons = [];
                if (!hasNormal && !baseEvent) {
                  buttons.push(<button key="set-debt" className="secondary" type="button" onClick={() => setOpeningFormOpen(true)}>Set opening debt</button>);
                }
                if (!hasNormal && baseEvent) {
                  buttons.push(<button key="cor-debt" className="secondary" type="button" onClick={() => setOpeningFormOpen(true)}>Correct opening debt</button>);
                }
                if (!hasNormal && !resEvent) {
                  buttons.push(<button key="set-ear" className="secondary" type="button" onClick={() => setEarmarkFormOpen(true)}>Set already-earmarked money</button>);
                }
                if (!hasNormal && resEvent) {
                  buttons.push(<button key="cor-ear" className="secondary" type="button" onClick={() => setEarmarkFormOpen(true)}>Correct already-earmarked money</button>);
                }
                return buttons.length > 0 ? buttons : null;
              })()}
            </div>
            <p className="section-label">Cycles</p>
            {data.cycles.length === 0 ? <p className="muted">No cycles yet.</p> : null}
            {data.cycles.map((cycle) => (
              <button className="list-row" type="button" key={cycle.id} onClick={() => onOpenCycle(cycle.id)}>
                <span>
                  Statement {cycle.expectedStatementOn}
                  <span className="muted"> · due {cycle.dueOn}</span>
                </span>
                <strong>{formatInr(paise(cycle.remainingPaise))}</strong>
              </button>
            ))}
            <p className="section-label">Purchases</p>
            {data.transactions.length === 0 ? <p className="muted">None yet.</p> : null}
            {data.transactions.map((event) => (
              <div className="list-row" key={event.id}>
                <span>
                  {event.meaning === "pay_obligation"
                    ? `Paid ${formatInr(paise(event.amountPaise))}`
                    : `${formatInr(paise(event.amountPaise))}${event.categories[0] ? ` · ${event.categories[0].name}` : ""}`}
                </span>
                <span className="muted">{event.occurredOn}</span>
              </div>
            ))}
          </>
        ) : null}
      </main>
      
      {openingFormOpen && data ? (
        <Sheet
          title={data.transactions.find(t => t.meaning === "apply_opening_card_position") ? "Correct opening debt" : "Set opening debt"}
          onClose={() => setOpeningFormOpen(false)}
        >
          <OpeningCardDebtForm
            cardId={cardId}
            cycleId={dueCycle?.id ?? data.cycles[0]?.id ?? ""} // Form will handle cycleId or backend will resolve
            isCorrection={!!data.transactions.find(t => t.meaning === "apply_opening_card_position")}
            currentAmountPaise={
              data.transactions
                .filter(t => t.meaning === "apply_opening_card_position" || t.meaning === "correct_opening_card_position")
                .reduce((acc, t) => acc + t.amountPaise, 0)
            }
            onDone={() => {
              setOpeningFormOpen(false);
              void fetchCard(cardId).then(setData);
            }}
          />
        </Sheet>
      ) : null}

      {earmarkFormOpen && data ? (
        <Sheet
          title={data.transactions.find(t => t.meaning === "apply_opening_reservation") ? "Correct earmarked money" : "Set already-earmarked money"}
          onClose={() => setEarmarkFormOpen(false)}
        >
          <OpeningEarmarkForm
            cardId={cardId}
            cycleId={dueCycle?.id ?? data.cycles[0]?.id ?? ""}
            accounts={accounts}
            isCorrection={!!data.transactions.find(t => t.meaning === "apply_opening_reservation")}
            currentAmountPaise={
              data.transactions
                .filter(t => t.meaning === "apply_opening_reservation" || t.meaning === "correct_opening_reservation")
                .reduce((acc, t) => acc + t.amountPaise, 0)
            }
            onDone={() => {
              setEarmarkFormOpen(false);
              void fetchCard(cardId).then(setData);
            }}
          />
        </Sheet>
      ) : null}
      {menuOpen && data ? (
        <Sheet title="Edit card" onClose={() => setMenuOpen(false)}>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void updateCard({
                cardId,
                displayName: rename,
                defaultOwnerPersonId: ownerPersonId || null,
              })
                .then(() => fetchCard(cardId))
                .then((card) => {
                  setData(card);
                  setRename(card.displayName);
                  setOwnerPersonId(card.defaultOwnerPersonId ?? "");
                  setMenuOpen(false);
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not save");
                });
            }}
          >
            <label>
              Name
              <input value={rename} onChange={(event) => setRename(event.target.value)} />
            </label>
            <label>
              Default owner
              <select value={ownerPersonId} onChange={(event) => setOwnerPersonId(event.target.value)}>
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
            <button className="secondary" type="submit">
              Save
            </button>
            <button
              className="secondary"
              type="button"
              onClick={() =>
                void updateCard({ cardId, status: "inactive" })
                  .then(onBack)
                  .catch((caught: unknown) => {
                    setError(caught instanceof ApiError ? caught.message : "Could not archive");
                  })
              }
            >
              Archive
            </button>
          </form>
        </Sheet>
      ) : null}
      
      {openingFormOpen && data && dueCycle ? (
        <Sheet title="Opening Debt" onClose={() => setOpeningFormOpen(false)}>
          <OpeningCardDebtForm
            cardId={cardId}
            cycleId={dueCycle.id}
            isCorrection={data.transactions.some(t => t.meaning === "apply_opening_card_position")}
            currentAmountPaise={data.outstandingPaise}
            onDone={() => {
              setOpeningFormOpen(false);
              fetchCard(cardId).then(card => setData(card));
            }}
          />
        </Sheet>
      ) : null}
    </>
  );
}
