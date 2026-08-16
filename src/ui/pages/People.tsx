import { useEffect, useState, type FormEvent } from "react";
import { formatInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  createPerson,
  fetchPeople,
  updatePerson,
  type PersonListItem,
} from "../apiClient.js";

type Props = {
  onOpenPerson: (id: string) => void;
};

function groupLabel(group: PersonListItem["group"]): string {
  if (group === "they_owe_you") return "They owe you";
  if (group === "you_owe") return "You owe";
  return "Settled";
}

export function People({ onOpenPerson }: Props) {
  const [people, setPeople] = useState<PersonListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameNotes, setRenameNotes] = useState("");

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
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create person");
    }
  }

  const groups: PersonListItem["group"][] = ["they_owe_you", "you_owe", "settled"];

  return (
    <>
      <header className="header">
        <h1>People</h1>
      </header>
      <main className="page">
        {groups.map((group) => {
          const rows = people.filter((person) => person.group === group);
          return (
            <section className="card stack" key={group}>
              <p>{groupLabel(group)}</p>
              {rows.length === 0 ? <p className="muted">None yet.</p> : null}
              {rows.map((person) => (
                <button
                  className="link-card"
                  type="button"
                  key={person.id}
                  onClick={() => onOpenPerson(person.id)}
                >
                  <div className="row">
                    <strong>
                      {person.name}
                      {person.status === "archived" ? " · archived" : ""}
                    </strong>
                    <span>{formatInr(paise(Math.abs(person.netPaise)))}</span>
                  </div>
                  <p className="muted">
                    They owe {formatInr(paise(person.theyOwePaise))} · You owe{" "}
                    {formatInr(paise(person.youOwePaise))} · {person.openItemCount} open
                  </p>
                </button>
              ))}
            </section>
          );
        })}
        <form className="card stack" onSubmit={(event) => void onCreate(event)}>
          <p>Add person</p>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Notes
            <input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <button className="primary" type="submit">
            Create person
          </button>
        </form>
        {renameId ? (
          <form
            className="card stack"
            onSubmit={(event) => {
              event.preventDefault();
              void updatePerson({
                personId: renameId,
                name: renameName,
                notes: renameNotes.trim() || null,
              })
                .then(() => {
                  setRenameId(null);
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not update");
                });
            }}
          >
            <p>Edit person</p>
            <input value={renameName} onChange={(event) => setRenameName(event.target.value)} />
            <input value={renameNotes} onChange={(event) => setRenameNotes(event.target.value)} />
            <button className="secondary" type="submit">
              Save
            </button>
          </form>
        ) : null}
        {people
          .filter((person) => person.status === "active")
          .map((person) => (
            <p className="muted" key={`edit-${person.id}`}>
              <button
                className="linkish"
                type="button"
                onClick={() => {
                  setRenameId(person.id);
                  setRenameName(person.name);
                  setRenameNotes(person.notes ?? "");
                }}
              >
                Rename {person.name}
              </button>
              {" · "}
              <button
                className="linkish"
                type="button"
                onClick={() =>
                  void updatePerson({ personId: person.id, status: "archived" })
                    .then(load)
                    .catch((caught: unknown) => {
                      setError(caught instanceof ApiError ? caught.message : "Could not archive");
                    })
                }
              >
                Archive
              </button>
            </p>
          ))}
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
