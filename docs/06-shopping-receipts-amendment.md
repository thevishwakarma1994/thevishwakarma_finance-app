# Amendment — Shopping sessions & receipts

**Status:** Documented. Do not implement yet. Does not replace Stages 3–5.

**Applies to:** UX (Add / Home), financial events (one payment), architecture (extractors outside the domain).

---

## Intent

Support live shopping (plan → affordability → checkout) and receipt capture (photo/upload → review → confirm) without turning OCR or a cart into accounting.

A shopping session is **planning**. It must not change balances, expenses, card liabilities, or monthly actual spend until the user confirms checkout/purchase.

---

## Entities (planning vs books)

| Entity | Kind | Writes the ledger? |
|---|---|---|
| **ShoppingSession** | Planning | No |
| **CartItem** | Planning | No |
| **ReceiptImage** | Artifact (blob/ref) | No |
| **ReceiptDraft** | Extraction pending review | No |
| **Receipt** | Confirmed purchase detail | Attached after confirm |
| **ReceiptLine** | Item on a confirmed receipt | No separate payment |
| **CategoryAllocation** | Expense split on one event | Via postings on confirm |

`ShoppingSession` → `CartItem[]` → running estimated total → `simulateAffordability()` → checkout → optional `ReceiptDraft` → user confirm → **one** `FinancialEvent` + `Receipt` + lines + allocations.

Workspace-scoped like other app data. Not passed into the pure engine.

---

## Relationship to FinancialEvent

Keep **one** purchase/payment event. Do **not** post a bank/card movement per receipt line.

```
FinancialEvent          meaning spend_account | spend_card | split
  Postings              1× account or card  +  1..n expense (by category)
  Receipt               merchant, date, total, image ref, optional session_id
    ReceiptLine[]       name, qty, unit price, line net, product id/barcode, category
    CategoryAllocation  derived from lines after discount/tax treatment
```

Confirmed **receipt total** is financial truth. Cart estimate is history only.

Conservation (compatible with Stage 4): for a personal purchase,

`account decrease` or `card liability increase` = **sum of expense postings** = receipt total.

Multiple categories on one payment = multiple `pnl=expense` postings on the **same** event, not multiple events. Header `categoryId` may be null when allocations exist; Month Review uses postings.

---

## Cart

Add via barcode, camera-assisted ID where available, or manual entry.

Fields: name, quantity, unit price, line total, suggested category, barcode/product id if any.

Barcode/product ID **must not** be treated as the store price. Price is user-confirmed or from a source the user accepts.

Edit/remove/qty/price before checkout. Show running total. Session may show as a **temporary** Home chip. No new nav tab.

Add picker extras (not meanings): **Start shopping**, **Scan a bill**.

---

## Affordability

Cart and pre-confirm receipt totals call existing `simulateAffordability(snapshot, asOf, proposal)` with the estimated/receipt amount and the intended funding (`account` or `card`). No second shopping formula. No ledger writes.

---

## Receipt capture

Photo or upload → `ReceiptExtractor` → `ReceiptDraft` → **user review/correction** → confirm.

Never commit extraction straight to postings. Preserve the image reference on the confirmed `Receipt`.

Draft should attempt: merchant, date, lines (qty, unit/line price), discounts, tax/charges, total.

---

## Discount / tax (allocation identity)

On confirm:

```
sum(category allocations) = FinancialEvent.amount = receipt.total
```

**V1 treatment (recommended):**

1. Line net = qty × unit price − line discount (paise integer math).
2. Ticket-level discount allocated **proportionally** across line nets (remainder paise to last line).
3. Tax/charges kept as **their own line(s)** with a user-chosen category (not silently folded into grocery). User may recategorize.
4. If the user edits allocations, the UI blocks save until they sum to the receipt total.

If extraction totals disagree with printed total, the **user-confirmed total** wins; lines must be adjusted before commit.

---

## Cart vs receipt

If a session exists: compare estimated total to confirmed receipt total (e.g. estimate ₹2,845, receipt ₹2,773, Δ −₹72). Difference is informational. Receipt/checkout amount is posted. Cart stays planning/history (`checked_out`), not reversed into the ledger.

---

## Extractors (outside the domain)

Provider-neutral ports, implementations not in `src/domain`:

- `ProductIdentifier` — barcode/image → { name, productId, suggestedCategory? }. **No price as truth.**
- `ReceiptExtractor` — image → `ReceiptDraft`.

Swap local/browser, OCR, vision model, or product DB without changing posting rules. Same idea as future bank import adapters.

---

## Analytics later

Store enough on `ReceiptLine` (name, product id, qty, unit price, category, merchant, date) to later answer grocery vs milk, price changes, repeats, store cost. **Do not build those views now.**

---

## Decisions

**S1.** Tax/charges as separate lines (recommended) vs spread into item categories.  
**S2.** When to run affordability: live on each cart change vs on demand vs at checkout only (engine is the same).  
**S3.** Image storage: local disk vs object store; retention. Not financial.
