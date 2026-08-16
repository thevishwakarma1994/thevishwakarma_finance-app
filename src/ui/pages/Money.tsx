import { useEffect, useState, type FormEvent } from "react";
import { formatInr, parseInr } from "../../domain/money/inr.js";
import { paise } from "../../domain/money/paise.js";
import { todayKolkata } from "../../domain/calendar/kolkata.js";
import {
  ApiError,
  createAccount,
  createCategory,
  fetchAccounts,
  fetchCategories,
  fetchMonth,
  previewOrCommitOpening,
  signOut,
  updateAccount,
  updateCategory,
  type Account,
  type Category,
  type MonthSpend,
} from "../apiClient.js";

type Props = {
  onSignedOut: () => void;
  onOpenMonth: () => void;
};

export function Money({ onSignedOut, onOpenMonth }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [month, setMonth] = useState<MonthSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingAccountId, setOpeningAccountId] = useState<string | null>(null);
  const [openingAmount, setOpeningAmount] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountKind, setNewAccountKind] = useState<"bank" | "cash">("bank");
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState("");
  const [renameAccountId, setRenameAccountId] = useState<string | null>(null);
  const [renameAccountName, setRenameAccountName] = useState("");
  const [renameCategoryId, setRenameCategoryId] = useState<string | null>(null);
  const [renameCategoryName, setRenameCategoryName] = useState("");

  function load() {
    return Promise.all([fetchAccounts(), fetchMonth(), fetchCategories()]).then(
      ([accountData, monthData, categoryData]) => {
        setAccounts(accountData.accounts);
        setMonth(monthData);
        setCategories(categoryData.categories);
      },
    );
  }

  useEffect(() => {
    Promise.all([fetchAccounts(), fetchMonth(), fetchCategories()])
      .then(([accountData, monthData, categoryData]) => {
        setAccounts(accountData.accounts);
        setMonth(monthData);
        setCategories(categoryData.categories);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : "Could not load accounts");
      });
  }, []);

  async function onSignOut() {
    try {
      await signOut();
    } catch {
      // Cookie/session may already be gone.
    }
    onSignedOut();
  }

  async function onOpening(event: FormEvent) {
    event.preventDefault();
    if (!openingAccountId) return;
    setError(null);
    try {
      await previewOrCommitOpening({
        accountId: openingAccountId,
        effectiveOn: todayKolkata(),
        balancePaise: parseInr(openingAmount),
        commit: true,
      });
      setOpeningAccountId(null);
      setOpeningAmount("");
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not set opening");
    }
  }

  async function onCreateAccount(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createAccount({ displayName: newAccountName, kind: newAccountKind });
      setNewAccountName("");
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create account");
    }
  }

  async function onCreateCategory(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createCategory({
        name: newCategoryName,
        parentId: newCategoryParentId || null,
      });
      setNewCategoryName("");
      setNewCategoryParentId("");
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create category");
    }
  }

  return (
    <>
      <header className="header">
        <h1>Money</h1>
        <button className="linkish" type="button" onClick={() => void onSignOut()}>
          Sign out
        </button>
      </header>
      <main className="page">
        {month ? (
          <button className="card link-card" type="button" onClick={onOpenMonth}>
            <p className="muted">Personal spending · {month.month}</p>
            <p className="balance">{formatInr(paise(month.spentPaise))}</p>
            <p className="muted">Open Month Review</p>
          </button>
        ) : null}
        {accounts.map((account) => (
          <section className="card" key={account.id}>
            <div className="row">
              <strong>
                {account.displayName}
                {account.mask ? ` · ${account.mask}` : ""}
                {account.kind === "cash" ? " · Cash" : ""}
                {account.isPrimarySalary ? " · Salary" : ""}
              </strong>
              <span>{formatInr(paise(account.balancePaise))}</span>
            </div>
            <p className="muted">Derived from opening + account movements</p>
            <div className="actions">
              {!account.hasOpening ? (
                <button className="secondary" type="button" onClick={() => setOpeningAccountId(account.id)}>
                  Set opening
                </button>
              ) : null}
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  setRenameAccountId(account.id);
                  setRenameAccountName(account.displayName);
                }}
              >
                Rename
              </button>
              {!account.isPrimarySalary ? (
                <button
                  className="secondary"
                  type="button"
                  onClick={() =>
                    void updateAccount({ accountId: account.id, isPrimarySalary: true })
                      .then(load)
                      .catch((caught: unknown) => {
                        setError(caught instanceof ApiError ? caught.message : "Could not update");
                      })
                  }
                >
                  Primary salary
                </button>
              ) : null}
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void updateAccount({ accountId: account.id, status: "archived" })
                    .then(load)
                    .catch((caught: unknown) => {
                      setError(caught instanceof ApiError ? caught.message : "Could not archive");
                    })
                }
              >
                Archive
              </button>
            </div>
          </section>
        ))}
        {openingAccountId ? (
          <form className="card stack" onSubmit={onOpening}>
            <p>Starting balance — this is not income.</p>
            <label>
              Amount (INR)
              <input
                inputMode="decimal"
                value={openingAmount}
                onChange={(event) => setOpeningAmount(event.target.value)}
                required
              />
            </label>
            <button className="primary" type="submit">
              Save opening
            </button>
          </form>
        ) : null}
        {renameAccountId ? (
          <form
            className="card stack"
            onSubmit={(event) => {
              event.preventDefault();
              void updateAccount({ accountId: renameAccountId, displayName: renameAccountName })
                .then(() => {
                  setRenameAccountId(null);
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not rename");
                });
            }}
          >
            <label>
              Account name
              <input value={renameAccountName} onChange={(event) => setRenameAccountName(event.target.value)} />
            </label>
            <button className="primary" type="submit">
              Save name
            </button>
          </form>
        ) : null}
        <form className="card stack" onSubmit={onCreateAccount}>
          <p>Add account</p>
          <label>
            Name
            <input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} required />
          </label>
          <label>
            Kind
            <select
              value={newAccountKind}
              onChange={(event) => setNewAccountKind(event.target.value as "bank" | "cash")}
            >
              <option value="bank">Bank</option>
              <option value="cash">Cash</option>
            </select>
          </label>
          <button className="primary" type="submit">
            Create account
          </button>
        </form>
        <section className="card stack">
          <p>Categories</p>
          {categories.map((category) => (
            <div className="row" key={category.id}>
              <span>
                {category.parentId
                  ? `${categories.find((item) => item.id === category.parentId)?.name ?? ""} / ${category.name}`
                  : category.name}
              </span>
              <span className="actions">
                <button
                  className="linkish"
                  type="button"
                  onClick={() => {
                    setRenameCategoryId(category.id);
                    setRenameCategoryName(category.name);
                  }}
                >
                  Rename
                </button>
                <button
                  className="linkish"
                  type="button"
                  onClick={() =>
                    void updateCategory({ categoryId: category.id, archive: true })
                      .then(load)
                      .catch((caught: unknown) => {
                        setError(caught instanceof ApiError ? caught.message : "Could not archive");
                      })
                  }
                >
                  Archive
                </button>
              </span>
            </div>
          ))}
          {renameCategoryId ? (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void updateCategory({ categoryId: renameCategoryId, name: renameCategoryName })
                  .then(() => {
                    setRenameCategoryId(null);
                    return load();
                  })
                  .catch((caught: unknown) => {
                    setError(caught instanceof ApiError ? caught.message : "Could not rename");
                  });
              }}
            >
              <input value={renameCategoryName} onChange={(event) => setRenameCategoryName(event.target.value)} />
              <button className="secondary" type="submit">
                Save category
              </button>
            </form>
          ) : null}
          <form className="stack" onSubmit={onCreateCategory}>
            <label>
              New category
              <input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} required />
            </label>
            <label>
              Parent (optional)
              <select
                value={newCategoryParentId}
                onChange={(event) => setNewCategoryParentId(event.target.value)}
              >
                <option value="">None</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="secondary" type="submit">
              Add category
            </button>
          </form>
        </section>
        {error ? <p className="danger">{error}</p> : null}
      </main>
    </>
  );
}
