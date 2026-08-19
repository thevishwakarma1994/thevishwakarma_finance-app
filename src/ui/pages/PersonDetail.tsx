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
  const [openingTheyOweOpen, setOpeningTheyOweOpen] = useState(false);
  const [openingIOweOpen, setOpeningIOweOpen] = useState(false);
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
            {(data.claims ?? data.openClaims).filter(c => c.status === "open").length === 0 ? <p className="muted">Nothing open</p> : null}
            {(data.claims ?? data.openClaims).filter(c => c.status === "open").map((claim) => (
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
                const claimsList = data.claims ?? data.openClaims;
                const openingTheyOwe = claimsList.find(c => c.originatingMeaning === "apply_opening_claim" && c.direction === "they_owe_user");
                const openingIOwe = claimsList.find(c => c.originatingMeaning === "apply_opening_claim" && c.direction === "user_owes_them");
                
                const canCorrectTheyOwe = openingTheyOwe && openingTheyOwe.status === "open" && openingTheyOwe.settledAmountPaise === 0;
                const canCorrectIOwe = openingIOwe && openingIOwe.status === "open" && openingIOwe.settledAmountPaise === 0;

                const buttons = [];
                
                if (!openingTheyOwe || canCorrectTheyOwe) {
                  buttons.push(
                    <button key="they-owe" className="secondary" type="button" onClick={() => setOpeningTheyOweOpen(true)}>
                      {openingTheyOwe ? "Correct opening 'They owe me'" : "Set opening 'They owe me'"}
                    </button>
                  );
                }
                
                if (!openingIOwe || canCorrectIOwe) {
                  buttons.push(
                    <button key="i-owe" className="secondary" type="button" onClick={() => setOpeningIOweOpen(true)}>
                      {openingIOwe ? "Correct opening 'I owe them'" : "Set opening 'I owe them'"}
                    </button>
                  );
                }
                
                return buttons.length > 0 ? buttons : null;
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
      {openingTheyOweOpen ? (
        <Sheet title="Opening position" onClose={() => setOpeningTheyOweOpen(false)}>
          {(() => {
            const claimsList = data?.claims ?? data?.openClaims ?? [];
            const openingTheyOwe = claimsList.find(c => c.originatingMeaning === "apply_opening_claim" && c.direction === "they_owe_user");
            
            return (
              <OpeningClaimForm
                personId={personId}
                isCorrection={!!openingTheyOwe}
                claimId={openingTheyOwe?.id}
                currentAmountPaise={openingTheyOwe?.openAmountPaise ?? 0}
                direction="they_owe_user"
                onDone={() => {
                  setOpeningTheyOweOpen(false);
                  load();
                }}
              />
            );
          })()}
        </Sheet>
      ) : null}

      {openingIOweOpen ? (
        <Sheet title="Opening position" onClose={() => setOpeningIOweOpen(false)}>
          {(() => {
            const claimsList = data?.claims ?? data?.openClaims ?? [];
            const openingIOwe = claimsList.find(c => c.originatingMeaning === "apply_opening_claim" && c.direction === "user_owes_them");
            
            return (
              <OpeningClaimForm
                personId={personId}
                isCorrection={!!openingIOwe}
                claimId={openingIOwe?.id}
                currentAmountPaise={openingIOwe?.openAmountPaise ?? 0}
                direction="user_owes_them"
                onDone={() => {
                  setOpeningIOweOpen(false);
                  load();
                }}
              />
            );
          })()}
        </Sheet>
      ) : null}
    </>
  );
}
