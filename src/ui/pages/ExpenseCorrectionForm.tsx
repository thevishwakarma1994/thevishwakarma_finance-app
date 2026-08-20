import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatInr, formatInrDelta, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  fetchAccounts,
  fetchCategories,
  previewOrCommitExpenseCorrection,
  type Account,
  type Category,
  type ExpenseCorrectionPreview,
  type TransactionDetailView,
} from "../apiClient.js";
import { Sheet } from "../chrome.js";

type Props = {
  detail: TransactionDetailView;
  onClose: () => void;
  onSaved: () => void;
};

function paiseToInput(value: number): string {
  const rupees = value / 100;
  return Number.isInteger(rupees) ? String(rupees) : rupees.toFixed(2);
}

export function ExpenseCorrectionForm({ detail, onClose, onSaved }: Props) {
  const commandIdRef = useRef(crypto.randomUUID());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [amount, setAmount] = useState(paiseToInput(detail.amountPaise));
  const [accountId, setAccountId] = useState(detail.accountId ?? "");
  const [allocations, setAllocations] = useState(
    detail.categories.length > 0
      ? detail.categories.map((category) => ({
          categoryId: category.id ?? "",
          amount: paiseToInput(category.amountPaise),
        }))
      : [{ categoryId: "", amount: paiseToInput(detail.amountPaise) }],
  );
  const [merchant, setMerchant] = useState(detail.merchant ?? "");
  const [notes, setNotes] = useState(detail.notes ?? "");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ExpenseCorrectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchCategories()])
      .then(([accountData, categoryData]) => {
        setAccounts(accountData.accounts);
        setCategories(categoryData.categories.filter((category) => !category.archivedAt));
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load form");
      });
  }, []);

  function parsedAllocations() {
    const amountPaise = parseInr(amount);
    const rows = allocations
      .filter((row) => row.categoryId)
      .map((row) => ({
        categoryId: row.categoryId,
        amountPaise: allocations.length === 1 ? amountPaise : parseInr(row.amount),
      }));
    if (rows.length === 0) {
      throw new Error("Choose a category");
    }
    return { amountPaise, rows };
  }

  async function run(commit: boolean) {
    const { amountPaise, rows } = parsedAllocations();
    return previewOrCommitExpenseCorrection({
      commandId: commandIdRef.current,
      rootEventId: detail.rootEventId,
      targetEventId: detail.targetEventId,
      amountPaise,
      sourceAccountId: accountId,
      occurredOn: detail.occurredOn,
      allocations: rows,
      merchant: merchant.trim() || null,
      notes: notes.trim() || null,
      reason: reason.trim() || null,
      commit,
    });
  }

  async function onPreview(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await run(false);
      setPreview(result.preview);
    } catch (caught: unknown) {
      setPreview(null);
      setError(caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : "Could not preview");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await run(true);
      onSaved();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const activeCategories = categories.filter((category) => !category.archivedAt);

  return (
    <Sheet
      title={preview ? "Preview changes" : "Correct transaction"}
      onClose={onClose}
      onBack={preview ? () => setPreview(null) : undefined}
      tall
      footer={
        preview ? (
          <button className="primary" type="button" disabled={busy} onClick={onConfirm}>
            Confirm correction
          </button>
        ) : (
          <button className="primary" type="submit" form="expense-correction-form" disabled={busy}>
            Preview changes
          </button>
        )
      }
    >
      {error ? <p className="danger">{error}</p> : null}
      {preview ? (
        <div className="stack" data-testid="correction-preview">
          <section className="card stack">
            <p className="muted">Original</p>
            <p>
              {formatInr(paise(preview.original.amountPaise))}
              {preview.original.accountName ? ` · ${preview.original.accountName}` : ""}
            </p>
            <p className="muted">
              {preview.original.categories.map((category) => category.name).join(", ") || "Expense"}
              {preview.original.merchant ? ` · ${preview.original.merchant}` : ""}
            </p>
          </section>
          <section className="card stack">
            <p className="muted">Corrected</p>
            <p>
              {formatInr(paise(preview.corrected.amountPaise))}
              {preview.corrected.accountName ? ` · ${preview.corrected.accountName}` : ""}
            </p>
            <p className="muted">
              {preview.corrected.categories.map((category) => category.name).join(", ") || "Expense"}
              {preview.corrected.merchant ? ` · ${preview.corrected.merchant}` : ""}
            </p>
          </section>
          <section className="card stack">
            <p className="muted">Financial impact</p>
            {preview.impact.length === 0 ? <p className="muted">No balance change</p> : null}
            {preview.impact.map((line) => (
              <p key={`${line.kind}-${line.label}`}>
                {line.label} {formatInrDelta(paise(line.deltaPaise))}
              </p>
            ))}
          </section>
        </div>
      ) : (
        <form id="expense-correction-form" className="stack" data-screen="expense-correction-form" onSubmit={onPreview}>
          <label>
            Amount
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                const next = event.target.value;
                setAmount(next);
                if (allocations.length === 1) {
                  setAllocations([{ ...allocations[0]!, amount: next }]);
                }
              }}
            />
          </label>
          <label>
            Account
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName}
                </option>
              ))}
            </select>
          </label>
          {allocations.map((row, index) => (
            <div className="stack" key={`alloc-${index}`}>
              <label>
                Category
                <select
                  value={row.categoryId}
                  onChange={(event) => {
                    const next = [...allocations];
                    next[index] = { ...row, categoryId: event.target.value };
                    setAllocations(next);
                  }}
                >
                  <option value="">Choose</option>
                  {activeCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              {allocations.length > 1 ? (
                <label>
                  Category amount
                  <input
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(event) => {
                      const next = [...allocations];
                      next[index] = { ...row, amount: event.target.value };
                      setAllocations(next);
                    }}
                  />
                </label>
              ) : null}
              {allocations.length > 1 ? (
                <button
                  className="text-action"
                  type="button"
                  onClick={() => setAllocations(allocations.filter((_, itemIndex) => itemIndex !== index))}
                >
                  Remove category
                </button>
              ) : null}
            </div>
          ))}
          <button
            className="text-action"
            type="button"
            onClick={() => setAllocations([...allocations, { categoryId: "", amount: "" }])}
          >
            Add category
          </button>
          <label>
            Merchant
            <input value={merchant} onChange={(event) => setMerchant(event.target.value)} />
          </label>
          <label>
            Notes
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
          <label>
            Reason for correction
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
        </form>
      )}
    </Sheet>
  );
}
