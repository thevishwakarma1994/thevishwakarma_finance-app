import { useEffect, useState, type FormEvent } from "react";
import {
  ApiError,
  createCategory,
  fetchCategories,
  updateCategory,
  type Category,
} from "../apiClient.js";
import { PageHeader, Sheet } from "../chrome.js";

type Props = {
  onBack: () => void;
};

export function ManageCategories({ onBack }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryParentId, setNewCategoryParentId] = useState("");
  const [editing, setEditing] = useState<Category | null>(null);
  const [renameName, setRenameName] = useState("");

  function load() {
    return fetchCategories().then((data) => setCategories(data.categories));
  }

  useEffect(() => {
    load().catch((caught: unknown) => {
      setError(caught instanceof ApiError ? caught.message : "Could not load categories");
    });
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await createCategory({
        name: newCategoryName,
        parentId: newCategoryParentId || null,
      });
      setNewCategoryName("");
      setNewCategoryParentId("");
      setAdding(false);
      await load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not create category");
    }
  }

  return (
    <>
      <PageHeader
        title="Categories"
        onBack={onBack}
        trailing={
          <button className="header-btn trailing" type="button" onClick={() => setAdding(true)}>
            Add
          </button>
        }
      />
      <main className="page" data-screen="manage-categories">
        <p className="page-lead muted">Labels for spending.</p>
        {error ? <p className="danger">{error}</p> : null}
        {categories.length === 0 ? <p className="muted">No categories yet.</p> : null}
        {categories.map((category) => (
          <button
            className="list-row"
            type="button"
            key={category.id}
            onClick={() => {
              setEditing(category);
              setRenameName(category.name);
            }}
          >
            <span className="list-row-title">
              {category.parentId
                ? `${categories.find((item) => item.id === category.parentId)?.name ?? ""} / ${category.name}`
                : category.name}
            </span>
            <span aria-hidden="true">···</span>
          </button>
        ))}
      </main>
      {adding ? (
        <Sheet
          title="Add category"
          onClose={() => setAdding(false)}
          footer={
            <button className="primary" type="submit" form="add-category-form">
              Add category
            </button>
          }
        >
          <form id="add-category-form" className="sheet-form" onSubmit={(event) => void onCreate(event)}>
            <label>
              Name
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
          </form>
        </Sheet>
      ) : null}
      {editing ? (
        <Sheet
          title="Category"
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="primary" type="submit" form="edit-category-form">
                Save
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() =>
                  void updateCategory({ categoryId: editing.id, archive: true })
                    .then(() => {
                      setEditing(null);
                      return load();
                    })
                    .catch((caught: unknown) => {
                      setError(caught instanceof ApiError ? caught.message : "Could not archive");
                    })
                }
              >
                Archive
              </button>
            </>
          }
        >
          <form
            id="edit-category-form"
            className="sheet-form"
            onSubmit={(event) => {
              event.preventDefault();
              void updateCategory({ categoryId: editing.id, name: renameName })
                .then(() => {
                  setEditing(null);
                  return load();
                })
                .catch((caught: unknown) => {
                  setError(caught instanceof ApiError ? caught.message : "Could not rename");
                });
            }}
          >
            <label>
              Name
              <input value={renameName} onChange={(event) => setRenameName(event.target.value)} />
            </label>
          </form>
        </Sheet>
      ) : null}
    </>
  );
}
