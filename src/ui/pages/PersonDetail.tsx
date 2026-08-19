import { useEffect, useState } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  fetchPerson,
  updatePerson,
  type PersonDetail as PersonDetailData,
} from "../apiClient.js";
import { PageHeader, Sheet, Skeleton } from "../chrome.js";
import { OverflowIcon } from "../icons.js";
import type { AddIntent } from "./Add.js";
import { OpeningClaimForm } from "../components/OpeningForms.js";

type Props = {
  personId: string;
  onBack: () => void;
  onCapture: (intent: Extract<AddIntent, "settlement_in" | "settlement_out">, personId: string) => void;
};

function claimKindLabel(kind: string): string {
  if (kind === "card_share") return "Card share";
  if (kind === "shared_bill") return "Shared bill";
  if (kind === "direct_loan") return "Lent";
  if (kind === "borrowing") return "Borrowed";
  if (kind === "opening") return "Opening";
  return kind;
}

export function PersonDetail({ personId, onBack, onCapture }: Props) {
  const [data, setData] = useState<PersonDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [openingOpen, setOpeningOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
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


  const oweThem = (data?.netPaise ?? 0) < 0;

  return (
    <>
      <PageHeader
        title={data?.name ?? "Person"}
        onBack={onBack}
        trailing={
          <button className="header-icon-btn" type="button" aria-label="More" onClick={() => setMenuOpen(true)}>
            <OverflowIcon />
          </button>
        }
      />
      <main className="page" data-screen="person-detail">
        {error ? <p className="danger">{error}</p> : null}
        {!data ? (
          <Skeleton />
        ) : (
          <>
            <p className="muted">Net position</p>
            <p className="hero-number">
              {data.netPaise >= 0 ? "They owe you " : "You owe "}
              {formatInr(paise(Math.abs(data.netPaise)))}
            </p>
            <p className="section-label">Open</p>
            {(data.claims ?? data.openClaims).length === 0 ? <p className="muted">Nothing open</p> : null}
            {(data.claims ?? data.openClaims).map((claim) => (
              <article key={claim.id}>
                <div className="row">
                  <strong>{claimKindLabel(claim.kind)}</strong>
                  <span>{formatInr(paise(claim.openAmountPaise))}</span>
                </div>
                <p className="muted">
                  {claim.status === "settled" ? "Settled" : "Open"}
                  {claim.direction === "they_owe_user" ? " · They owe you" : " · You owe them"}
                  {claim.cardLabel ? ` · ${claim.cardLabel}` : ""}
                </p>
              </article>
            ))}
            <div className="stack">
              <button
                className="primary"
                type="button"
                onClick={() => onCapture(oweThem ? "settlement_out" : "settlement_in", personId)}
              >
                {oweThem ? "I paid them" : "They paid me"}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => onCapture(oweThem ? "settlement_in" : "settlement_out", personId)}
              >
                {oweThem ? "They paid me" : "I paid them"}
              </button>

              {(() => {
                const hasNormal = data.history.some(t => !t.meaning.includes("opening"));
                const hasBase = data.history.some(t => t.meaning === "apply_opening_claim");
                if (!hasNormal && !hasBase) {
                  return <button className="secondary" type="button" onClick={() => setOpeningOpen(true)}>Set opening balance</button>;
                }
                if (!hasNormal && hasBase) {
                  return <button className="secondary" type="button" onClick={() => setOpeningOpen(true)}>Correct opening balance</button>;
                }
                return null;
              })()}
            </div>
            <button className="text-action" type="button" onClick={() => setHistoryOpen((open) => !open)}>
              {historyOpen ? "Hide history" : "History"}
            </button>
            {historyOpen
              ? data.history.map((event) => (
                  <article key={event.id}>
                    <div className="row">
                      <strong>
                        {event.meaning === "settlement_in"
                          ? `${event.counterpartyName ?? data.name} paid you`
                          : event.meaning === "settlement_out"
                            ? `You paid ${event.counterpartyName ?? data.name}`
                            : (event.merchant ?? event.meaning.replaceAll("_", " "))}
                      </strong>
                      <span>{formatInr(paise(event.amountPaise))}</span>
                    </div>
                    <p className="muted">{event.occurredOn}</p>
                  </article>
                ))
              : null}
          </>
        )}
      </main>
      {menuOpen && data ? (
        <Sheet title="Manage" onClose={() => setMenuOpen(false)}>
          <button
            className="list-row"
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setNotesOpen(true);
            }}
          >
            Notes
          </button>
          {!data.hasOpening ? (
            <button
              className="list-row"
              type="button"
              onClick={() => {
                setMenuOpen(false);
                setOpeningOpen(true);
              }}
            >
              Opening position
            </button>
          ) : (
            <p className="muted">Opening set {data.openingEffectiveOn}</p>
          )}
          {data.status === "active" ? (
            <button
              className="list-row"
              type="button"
              onClick={() =>
                void updatePerson({ personId, status: "archived" })
                  .then(() => {
                    setMenuOpen(false);
                    return load();
                  })
                  .catch((caught: unknown) => {
                    setError(caught instanceof ApiError ? caught.message : "Could not archive");
                  })
              }
            >
              Archive
            </button>
          ) : null}
        </Sheet>
      ) : null}
      {notesOpen && data ? (
        <Sheet title="Notes" onClose={() => setNotesOpen(false)}>
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void updatePerson({ personId, notes: notes.trim() || null })
                .then(() => {
                  setNotesOpen(false);
                  return load();
                })
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
        </Sheet>
      ) : null}
      {openingOpen ? (
        <Sheet title="Opening position" onClose={() => setOpeningOpen(false)}>
          <OpeningClaimForm
            personId={personId}
            isCorrection={data?.history.some(t => t.meaning === "apply_opening_claim") ?? false}
            claimId={data?.openClaims.find(c => c.kind === "direct_loan" || c.kind === "borrowing")?.id}
            currentAmountPaise={data?.openClaims.find(c => c.kind === "direct_loan" || c.kind === "borrowing")?.openAmountPaise ?? 0}
            onDone={() => {
              setOpeningOpen(false);
              load();
            }}
          />
        </Sheet>
      ) : null}
    </>
  );
}
