import { useEffect, useState, type FormEvent } from "react";
import { formatInr, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  fetchPerson,
  previewOrCommitOpening,
  updatePerson,
  type PersonDetail,
} from "../apiClient.js";

type Props = {
  personId: string;
  onBack: () => void;
};

function claimKindLabel(kind: string): string {
  if (kind === "card_share") return "Card share";
  if (kind === "shared_bill") return "Shared bill";
  if (kind === "direct_loan") return "Lent";
  if (kind === "borrowing") return "Borrowed";
  if (kind === "opening") return "Opening";
  return kind;
}

export function PersonDetail({ personId, onBack }: Props) {
  const [data, setData] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingAmount, setOpeningAmount] = useState("");
  const [openingDirection, setOpeningDirection] = useState<"they_owe_user" | "user_owes_them">(
    "they_owe_user",
  );
  const [notes, setNotes] = useState("");

  function load() {
    return fetchPerson(personId).then((person) => {
      setData(person);
      setNotes(person.notes ?? "");
    });
  }

  useEffect(() => {
    fetchPerson(personId)
      .then((person) => {
        setData(person);
        setNotes(person.notes ?? "");
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load person");
      });
  }, [personId]);

  async function onOpening(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await previewOrCommitOpening({
        personId,
        effectiveOn: todayKolkata(),
        direction: openingDirection,
        amountPaise: parseInr(openingAmount),
        commit: true,
      });
      setOpeningAmount("");
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save opening");
    }
  }

  if (!data) {
    return (
      <>
        <header className="header">
          <h1>Person</h1>
          <button className="linkish" type="button" onClick={onBack}>
            Back
          </button>
        </header>
        <main className="page">
          {error ? <p className="danger">{error}</p> : <p className="muted">Loading…</p>}
        </main>
      </>
    );
  }

  return (
    <>
      <header className="header">
        <h1>{data.name}</h1>
        <button className="linkish" type="button" onClick={onBack}>
          Back
        </button>
      </header>
      <main className="page">
        <section className="card">
          <p className="muted">Net position</p>
          <p className="balance">
            {data.netPaise >= 0 ? "They owe you " : "You owe "}
            {formatInr(paise(Math.abs(data.netPaise)))}
          </p>
          <p className="muted">
            They owe {formatInr(paise(data.theyOwePaise))} · You owe {formatInr(paise(data.youOwePaise))}
            {data.status === "archived" ? " · archived" : ""}
          </p>
        </section>
        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            void updatePerson({ personId, notes: notes.trim() || null })
              .then(load)
              .catch((caught: unknown) => {
                setError(caught instanceof ApiError ? caught.message : "Could not save notes");
              });
          }}
        >
          <label>
            Notes
            <input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <button className="secondary" type="submit">
            Save notes
          </button>
        </form>
        <section className="card stack">
          <p>Open claims</p>
          {data.openClaims.length === 0 ? <p className="muted">None open.</p> : null}
          {data.openClaims.map((claim) => (
            <article key={claim.id}>
              <div className="row">
                <strong>{claimKindLabel(claim.kind)}</strong>
                <span>{formatInr(paise(claim.openAmountPaise))}</span>
              </div>
              <p className="muted">
                {claim.direction === "they_owe_user" ? "They owe you" : "You owe them"}
                {claim.originatingMeaning ? ` · ${claim.originatingMeaning.replaceAll("_", " ")}` : ""}
                {claim.originatingMerchant ? ` · ${claim.originatingMerchant}` : ""}
                {claim.cardLabel ? ` · ${claim.cardLabel}` : ""}
                {claim.cycleStatementOn ? ` · cycle ${claim.cycleStatementOn}` : ""}
                {claim.occurredOn ? ` · ${claim.occurredOn}` : ""}
              </p>
            </article>
          ))}
          <p className="muted">Settlements come later.</p>
        </section>
        {!data.hasOpening ? (
          <form className="card stack" onSubmit={(event) => void onOpening(event)}>
            <p>Opening position</p>
            <label>
              Direction
              <select
                value={openingDirection}
                onChange={(event) =>
                  setOpeningDirection(event.target.value as "they_owe_user" | "user_owes_them")
                }
              >
                <option value="they_owe_user">They owe you</option>
                <option value="user_owes_them">You owe them</option>
              </select>
            </label>
            <label>
              Amount (INR)
              <input
                inputMode="decimal"
                value={openingAmount}
                onChange={(event) => setOpeningAmount(event.target.value)}
                required
              />
            </label>
            <button className="secondary" type="submit">
              Save opening
            </button>
          </form>
        ) : (
          <p className="muted">Opening set {data.openingEffectiveOn}</p>
        )}
        <section className="card stack">
          <p>History</p>
          {data.history.length === 0 ? <p className="muted">No events yet.</p> : null}
          {data.history.map((event) => (
            <article key={event.id}>
              <div className="row">
                <strong>
                  {event.merchant ?? event.meaning.replaceAll("_", " ")}
                </strong>
                <span>{formatInr(paise(event.amountPaise))}</span>
              </div>
              <p className="muted">{event.occurredOn}</p>
            </article>
          ))}
        </section>
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
