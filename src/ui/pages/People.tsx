import { useEffect, useState, type FormEvent } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  createPerson,
  fetchPeople,
  type PersonListItem,
} from "../apiClient.js";
import { EmptyState, ErrorState, PageHeader, PlusIcon, RowChevron, Sheet, Skeleton } from "../chrome.js";

type Props = {
  onOpenPerson: (id: string) => void;
};

function groupLabel(group: PersonListItem["group"]): string {
  if (group === "they_owe_you") return "They owe you";
  if (group === "you_owe") return "You owe";
  return "Settled";
}

function netCopy(person: PersonListItem): string {
  if (person.netPaise > 0) return "They owe you";
  if (person.netPaise < 0) return "You owe";
  return "Settled";
}

export function People({ onOpenPerson }: Props) {
  const [people, setPeople] = useState<PersonListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");

  function load() {
    return fetchPeople().then((data) => setPeople(data.people));
  }

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load people");
    });
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createPerson({ name, notes: notes.trim() || null });
      setName("");
      setNotes("");
      setAdding(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create person");
    }
  }

  const groups: PersonListItem["group"][] = ["they_owe_you", "you_owe", "settled"];
  const list = people ?? [];

  return (
    <>
      <PageHeader
        title="People"
        trailing={
          <button className="header-icon-btn" type="button" aria-label="Add person" onClick={() => setAdding(true)}>
            <PlusIcon />
          </button>
        }
      />
      <main className="page">
        {error ? (
          <ErrorState
            message={error}
            onRetry={() => {
              setError(null);
              void load();
            }}
          />
        ) : null}
        {people === null && !error ? <Skeleton rows={4} /> : null}
        {people && people.length === 0 ? (
          <EmptyState title="No people yet." actionLabel="Add a person" onAction={() => setAdding(true)} />
        ) : null}
        {groups.map((group) => {
          const rows = list.filter((person) => person.group === group);
          if (rows.length === 0) return null;
          return (
            <section key={group}>
              <p className="section-label">{groupLabel(group)}</p>
              {rows.map((person) => (
                <button
                  className="list-row"
                  type="button"
                  key={person.id}
                  onClick={() => onOpenPerson(person.id)}
                >
                  <span className="list-row-copy">
                    <span className="list-row-title">
                      {person.name}
                      {person.status === "archived" ? " · archived" : ""}
                    </span>
                    <span className="list-row-meta">
                      {netCopy(person)}
                      {person.openItemCount ? ` · ${person.openItemCount} open` : ""}
                    </span>
                  </span>
                  <span className="amount">{formatInr(paise(Math.abs(person.netPaise)))}</span>
                  <RowChevron />
                </button>
              ))}
            </section>
          );
        })}
      </main>
      {adding ? (
        <Sheet
          title="Add person"
          onClose={() => setAdding(false)}
          footer={
            <button className="primary" type="submit" form="add-person-form">
              Create person
            </button>
          }
        >
          <form id="add-person-form" className="sheet-form" onSubmit={(event) => void onCreate(event)}>
            <label>
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label>
              Notes (optional)
              <input value={notes} onChange={(event) => setNotes(event.target.value)} />
            </label>
          </form>
        </Sheet>
      ) : null}
    </>
  );
}
