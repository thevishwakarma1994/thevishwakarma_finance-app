import { useEffect, useRef, useState, type FormEvent } from "react";
import { formatInr, formatInrDelta, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import {
  ApiError,
  fetchAccounts,
  previewOrCommitOtherIncomeCorrection,
  type Account,
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

export function OtherIncomeCorrectionForm({ detail, onClose, onSaved }: Props) {
  const commandIdRef = useRef(crypto.randomUUID());
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [amount, setAmount] = useState(paiseToInput(detail.amountPaise));
  const [accountId, setAccountId] = useState(detail.accountId ?? "");
  const [notes, setNotes] = useState(detail.notes ?? "");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ExpenseCorrectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchAccounts()
      .then((accountData) => {
        setAccounts(accountData.accounts);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load form");
      });
  }, []);

  async function run(commit: boolean) {
    return previewOrCommitOtherIncomeCorrection({
      commandId: commandIdRef.current,
      rootEventId: detail.rootEventId,
      targetEventId: detail.targetEventId,
      amountPaise: parseInr(amount),
      destinationAccountId: accountId,
      occurredOn: detail.occurredOn,
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
          <button className="primary" type="submit" form="other-income-correction-form" disabled={busy}>
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
              {preview.original.accountName ? ` → ${preview.original.accountName}` : ""}
            </p>
          </section>
          <section className="card stack">
            <p className="muted">Corrected</p>
            <p>
              {formatInr(paise(preview.corrected.amountPaise))}
              {preview.corrected.accountName ? ` → ${preview.corrected.accountName}` : ""}
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
        <form
          id="other-income-correction-form"
          className="stack"
          data-screen="other-income-correction-form"
          onSubmit={onPreview}
        >
          <p className="muted">Date {detail.occurredOn}</p>
          <label>
            Amount
            <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
          </label>
          <label>
            Destination account
            <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName}
                </option>
              ))}
            </select>
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
