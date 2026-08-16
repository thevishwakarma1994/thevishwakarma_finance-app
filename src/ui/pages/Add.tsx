import { useEffect, useState, type FormEvent } from "react";
import { parseInr } from "../../domain/money/inr.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  fetchAccounts,
  fetchCategories,
  previewOrCommitExpense,
  previewOrCommitIncome,
  type Account,
  type Category,
  type ConsequencePreview,
} from "../apiClient.js";

type Intent = "income" | "expense" | null;

type Props = {
  onDone: () => void;
};

export function Add({ onDone }: Props) {
  const [intent, setIntent] = useState<Intent>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accountId, setAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [occurredOn, setOccurredOn] = useState<string>(todayKolkata());
  const [kind, setKind] = useState<"salary" | "other">("salary");
  const [merchant, setMerchant] = useState("");
  const [preview, setPreview] = useState<ConsequencePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchCategories()])
      .then(([accountData, categoryData]) => {
        setAccounts(accountData.accounts);
        setCategories(categoryData.categories);
        setAccountId(accountData.accounts[0]?.id ?? "");
        setCategoryId(categoryData.categories[0]?.id ?? "");
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load form");
      });
  }, []);

  async function onPreview(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const amountPaise = parseInr(amount);
      if (intent === "income") {
        const result = await previewOrCommitIncome({
          occurredOn,
          amountPaise,
          accountId,
          kind,
          commit: false,
        });
        setPreview(result.preview);
      } else {
        const result = await previewOrCommitExpense({
          occurredOn,
          accountId,
          allocations: [{ categoryId, amountPaise }],
          merchant: merchant.trim() || null,
          commit: false,
        });
        setPreview(result.preview);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not preview");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      const amountPaise = parseInr(amount);
      if (intent === "income") {
        await previewOrCommitIncome({
          occurredOn,
          amountPaise,
          accountId,
          kind,
          commit: true,
        });
      } else {
        await previewOrCommitExpense({
          occurredOn,
          accountId,
          allocations: [{ categoryId, amountPaise }],
          merchant: merchant.trim() || null,
          commit: true,
        });
      }
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!intent) {
    return (
      <>
        <header className="header">
          <h1>Add</h1>
        </header>
        <main className="page choice">
          <button className="primary" type="button" onClick={() => setIntent("income")}>
            I got paid
          </button>
          <button className="secondary" type="button" onClick={() => setIntent("expense")}>
            I spent money
          </button>
        </main>
      </>
    );
  }

  if (preview) {
    return (
      <>
        <header className="header">
          <h1>Check this first</h1>
        </header>
        <main className="page">
          <section className="card preview">
            {preview.narrative.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
          {error ? <p className="danger">{error}</p> : null}
          <div className="stack">
            <button className="primary" type="button" disabled={busy} onClick={() => void onConfirm()}>
              Save
            </button>
            <button className="secondary" type="button" onClick={() => setPreview(null)}>
              Back
            </button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <header className="header">
        <h1>{intent === "income" ? "I got paid" : "I spent money"}</h1>
      </header>
      <main className="page">
        <form className="card stack" onSubmit={onPreview}>
          <label>
            Amount (INR)
            <input
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
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
          {intent === "income" ? (
            <label>
              Kind
              <select value={kind} onChange={(event) => setKind(event.target.value as "salary" | "other")}>
                <option value="salary">Salary</option>
                <option value="other">Other income</option>
              </select>
            </label>
          ) : (
            <>
              <label>
                Category
                <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Merchant (optional)
                <input value={merchant} onChange={(event) => setMerchant(event.target.value)} />
              </label>
            </>
          )}
          <label>
            Date
            <input type="date" value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} />
          </label>
          {error ? <p className="danger">{error}</p> : null}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Checking…" : "See what this will do"}
          </button>
          <button className="secondary" type="button" onClick={() => setIntent(null)}>
            Cancel
          </button>
        </form>
      </main>
    </>
  );
}
