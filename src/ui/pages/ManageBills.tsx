import { useEffect, useState, type FormEvent } from "react";
import { parseInr } from "../../domain/money/inr.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  archiveObligationTemplate,
  changeObligationFrom,
  createOneOffObligation,
  createObligationTemplate,
  fetchObligationTemplates,
} from "../apiClient.js";
import { PageHeader, Sheet } from "../chrome.js";

type Template = {
  id: string;
  name: string;
  priority: string;
  dueRule: { dayOfMonth: number };
  effectiveFrom: string;
  effectiveTo: string | null;
  amountPaise: number | null;
};

type Props = {
  onBack: () => void;
};

function priorityLabel(priority: string): string {
  if (priority === "must_pay") return "Must pay";
  if (priority === "committed") return "Protected";
  if (priority === "planned") return "Planned";
  return priority.replaceAll("_", " ");
}

export function ManageBills({ onBack }: Props) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"pick" | "recurring" | "one-off" | null>(null);
  const [editing, setEditing] = useState<Template | null>(null);
  const [oblName, setOblName] = useState("Rent");
  const [oblDay, setOblDay] = useState("5");
  const [oblAmount, setOblAmount] = useState("12000");
  const [oblPriority, setOblPriority] = useState<"must_pay" | "committed" | "planned">("must_pay");
  const [oneOffName, setOneOffName] = useState("");
  const [oneOffDue, setOneOffDue] = useState<string>(todayKolkata());
  const [oneOffAmount, setOneOffAmount] = useState("");
  const [editFrom, setEditFrom] = useState<string>(todayKolkata());
  const [editAmount, setEditAmount] = useState("");
  const [archiveTo, setArchiveTo] = useState<string>(todayKolkata());
  const [editMode, setEditMode] = useState<"change" | "archive" | null>(null);

  function load() {
    return fetchObligationTemplates().then((data) => setTemplates(data.templates));
  }

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load bills");
    });
  }, []);

  async function onCreateRecurring(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createObligationTemplate({
        name: oblName,
        priority: oblPriority,
        dayOfMonth: Number(oblDay),
        amountPaise: parseInr(oblAmount),
        effectiveFrom: todayKolkata(),
      });
      setAdding(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save bill");
    }
  }

  async function onCreateOneOff(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createOneOffObligation({
        name: oneOffName,
        dueOn: oneOffDue,
        amountPaise: parseInr(oneOffAmount),
        priority: oblPriority,
      });
      setOneOffName("");
      setAdding(null);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save one-off");
    }
  }

  return (
    <>
      <PageHeader
        title="Bills"
        onBack={onBack}
        trailing={
          <button className="header-btn trailing" type="button" onClick={() => setAdding("pick")}>
            Add
          </button>
        }
      />
      <main className="page" data-screen="manage-bills">
        <p className="page-lead muted">Recurring and one-off payments that come due.</p>
        {error ? <p className="danger">{error}</p> : null}
        <p className="section-label">Recurring</p>
        {templates.length === 0 ? <p className="muted">No recurring bills yet.</p> : null}
        {templates.map((template) => (
          <button
            className="list-row"
            type="button"
            key={template.id}
            onClick={() => {
              setEditing(template);
              setEditMode(null);
              setEditAmount(template.amountPaise !== null ? String(template.amountPaise / 100) : "");
            }}
          >
            <span className="list-row-copy">
              <span className="list-row-title">{template.name}</span>
              <span className="muted">
                Day {template.dueRule.dayOfMonth} · {priorityLabel(template.priority)}
                {template.effectiveTo ? ` · ends ${template.effectiveTo}` : ""}
              </span>
            </span>
            <span aria-hidden="true">···</span>
          </button>
        ))}
      </main>
      {adding === "pick" ? (
        <Sheet title="Add bill" onClose={() => setAdding(null)}>
          <button className="list-row" type="button" onClick={() => setAdding("recurring")}>
            <span className="list-row-copy">
              <span className="list-row-title">Recurring</span>
              <span className="muted">Rent, EMI, and other repeats</span>
            </span>
            <span className="list-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>
          <button className="list-row" type="button" onClick={() => setAdding("one-off")}>
            <span className="list-row-copy">
              <span className="list-row-title">One-off</span>
              <span className="muted">A single due item</span>
            </span>
            <span className="list-row-chevron" aria-hidden="true">
              ›
            </span>
          </button>
        </Sheet>
      ) : null}
      {adding === "recurring" ? (
        <Sheet
          title="Add bill"
          tall
          onClose={() => setAdding(null)}
          onBack={() => setAdding("pick")}
          footer={
            <button className="primary" type="submit" form="add-bill-form">
              Save bill
            </button>
          }
        >
          <form id="add-bill-form" className="sheet-form" onSubmit={(event) => void onCreateRecurring(event)}>
            <label>
              Name
              <input value={oblName} onChange={(event) => setOblName(event.target.value)} required />
            </label>
            <label>
              Due day
              <input value={oblDay} onChange={(event) => setOblDay(event.target.value)} required />
            </label>
            <label>
              Amount
              <input value={oblAmount} onChange={(event) => setOblAmount(event.target.value)} required />
            </label>
            <label>
              Priority
              <select
                value={oblPriority}
                onChange={(event) =>
                  setOblPriority(event.target.value as "must_pay" | "committed" | "planned")
                }
              >
                <option value="must_pay">Must pay</option>
                <option value="committed">Protected</option>
                <option value="planned">Planned</option>
              </select>
            </label>
          </form>
        </Sheet>
      ) : null}
      {adding === "one-off" ? (
        <Sheet
          title="Add one-off"
          onClose={() => setAdding(null)}
          onBack={() => setAdding("pick")}
          footer={
            <button className="primary" type="submit" form="add-oneoff-form">
              Save one-off
            </button>
          }
        >
          <form id="add-oneoff-form" className="sheet-form" onSubmit={(event) => void onCreateOneOff(event)}>
            <label>
              Name
              <input value={oneOffName} onChange={(event) => setOneOffName(event.target.value)} required />
            </label>
            <label>
              Due
              <input type="date" value={oneOffDue} onChange={(event) => setOneOffDue(event.target.value)} required />
            </label>
            <label>
              Amount
              <input value={oneOffAmount} onChange={(event) => setOneOffAmount(event.target.value)} required />
            </label>
            <label>
              Priority
              <select
                value={oblPriority}
                onChange={(event) =>
                  setOblPriority(event.target.value as "must_pay" | "committed" | "planned")
                }
              >
                <option value="must_pay">Must pay</option>
                <option value="committed">Protected</option>
                <option value="planned">Planned</option>
              </select>
            </label>
          </form>
        </Sheet>
      ) : null}
      {editing && !editMode ? (
        <Sheet title={editing.name} onClose={() => setEditing(null)}>
          <button className="list-row" type="button" onClick={() => setEditMode("change")}>
            Change from date
          </button>
          <button className="list-row" type="button" onClick={() => setEditMode("archive")}>
            End bill
          </button>
        </Sheet>
      ) : null}
      {editing && editMode === "change" ? (
        <Sheet
          title="Change from date"
          onClose={() => setEditing(null)}
          onBack={() => setEditMode(null)}
          footer={
            <button className="primary" type="submit" form="change-bill-form">
              Apply from date
            </button>
          }
        >
          <form
            id="change-bill-form"
            className="sheet-form"
            onSubmit={(event) => {
              event.preventDefault();
              void changeObligationFrom({
                templateId: editing.id,
                effectiveFrom: editFrom,
                amountPaise: parseInr(editAmount),
                priority: oblPriority,
              })
                .then(() => {
                  setEditing(null);
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not change bill");
                });
            }}
          >
            <label>
              Effective from
              <input type="date" value={editFrom} onChange={(event) => setEditFrom(event.target.value)} required />
            </label>
            <label>
              New amount
              <input value={editAmount} onChange={(event) => setEditAmount(event.target.value)} required />
            </label>
          </form>
        </Sheet>
      ) : null}
      {editing && editMode === "archive" ? (
        <Sheet
          title="End bill"
          onClose={() => setEditing(null)}
          onBack={() => setEditMode(null)}
          footer={
            <button className="primary" type="submit" form="end-bill-form">
              Archive template
            </button>
          }
        >
          <form
            id="end-bill-form"
            className="sheet-form"
            onSubmit={(event) => {
              event.preventDefault();
              void archiveObligationTemplate({ templateId: editing.id, effectiveTo: archiveTo })
                .then(() => {
                  setEditing(null);
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not end bill");
                });
            }}
          >
            <label>
              End on
              <input type="date" value={archiveTo} onChange={(event) => setArchiveTo(event.target.value)} required />
            </label>
          </form>
        </Sheet>
      ) : null}
    </>
  );
}
