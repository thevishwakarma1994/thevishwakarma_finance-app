import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createAccount,
  fetchAccounts,
  updateAccount,
  type Account,
} from "../apiClient.js";
import { PageHeader, Sheet } from "../chrome.js";

type Props = {
  onBack: () => void;
};

type RowAction = "menu" | "rename";

export function ManageAccounts({ onBack }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountKind, setNewAccountKind] = useState<"bank" | "cash">("bank");
  const [selected, setSelected] = useState<Account | null>(null);
  const [rowAction, setRowAction] = useState<RowAction | null>(null);
  const [renameName, setRenameName] = useState("");

  function load() {
    return fetchAccounts().then((data) => setAccounts(data.accounts));
  }

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load accounts");
    });
  }, []);

  function closeRow() {
    setSelected(null);
    setRowAction(null);
  }

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createAccount({ displayName: newAccountName, kind: newAccountKind });
      setNewAccountName("");
      setAdding(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create account");
    }
  }

  return (
    <>
      <PageHeader
        title="Accounts"
        onBack={onBack}
        trailing={
          <button className="header-btn trailing" type="button" onClick={() => setAdding(true)}>
            Add
          </button>
        }
      />
      <main className="page" data-screen="manage-accounts">
        <p className="page-lead muted">Banks and cash you spend from.</p>
        {error ? <p className="danger">{error}</p> : null}
        {accounts.length === 0 ? (
          <p className="muted">No accounts yet.</p>
        ) : null}
        {accounts.map((account) => (
          <button
            className="list-row"
            type="button"
            key={account.id}
            onClick={() => {
              setSelected(account);
              setRowAction("menu");
              setRenameName(account.displayName);
            }}
          >
            <span className="list-row-copy">
              <span className="list-row-title">{account.displayName}</span>
              <span className="muted">
                {account.kind === "cash" ? "Cash" : "Bank"}
                {account.isPrimarySalary ? " · Salary" : ""}
              </span>
            </span>
            <span aria-hidden="true">···</span>
          </button>
        ))}
      </main>
      {adding ? (
        <Sheet
          title="Add account"
          onClose={() => setAdding(false)}
          footer={
            <button className="primary" type="submit" form="add-account-form">
              Create account
            </button>
          }
        >
          <form id="add-account-form" className="sheet-form" onSubmit={(event) => void onCreate(event)}>
            <label>
              Name
              <input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} required />
            </label>
            <label>
              Type
              <select
                value={newAccountKind}
                onChange={(event) => setNewAccountKind(event.target.value as "bank" | "cash")}
              >
                <option value="bank">Bank</option>
                <option value="cash">Cash</option>
              </select>
            </label>
          </form>
        </Sheet>
      ) : null}
      {selected && rowAction === "menu" ? (
        <Sheet title={selected.displayName} onClose={closeRow}>
          <button className="list-row" type="button" onClick={() => setRowAction("rename")}>
            Rename
          </button>

          {!selected.isPrimarySalary ? (
            <button
              className="list-row"
              type="button"
              onClick={() =>
                void updateAccount({ accountId: selected.id, isPrimarySalary: true })
                  .then(() => {
                    closeRow();
                    return load();
                  })
                  .catch((caught: unknown) => {
                    setError(caught instanceof ApiError ? caught.message : "Could not update");
                  })
              }
            >
              Salary account
            </button>
          ) : null}
          <button
            className="list-row"
            type="button"
            onClick={() =>
              void updateAccount({ accountId: selected.id, status: "archived" })
                .then(() => {
                  closeRow();
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not archive");
                })
            }
          >
            Archive
          </button>
        </Sheet>
      ) : null}
      {selected && rowAction === "rename" ? (
        <Sheet
          title="Rename"
          onClose={closeRow}
          onBack={() => setRowAction("menu")}
          footer={
            <button className="primary" type="submit" form="rename-account-form">
              Save name
            </button>
          }
        >
          <form
            id="rename-account-form"
            className="sheet-form"
            onSubmit={(event) => {
              event.preventDefault();
              void updateAccount({ accountId: selected.id, displayName: renameName })
                .then(() => {
                  closeRow();
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not rename");
                });
            }}
          >
            <label>
              Account name
              <input value={renameName} onChange={(event) => setRenameName(event.target.value)} />
            </label>
          </form>
        </Sheet>
      ) : null}
    </>
  );
}
