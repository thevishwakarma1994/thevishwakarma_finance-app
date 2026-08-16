# Stage 3 — Information Architecture & UX

**Status:** Approved with amendments (2026-08-16). Do not implement screens yet.

**Amendments absorbed in Stage 4:** D4 suggestion-only allocation; D5 typed opening positions; D9 account-scoped + obligation-linked reservations; D10 surplus reconciliation (never auto-available). See `docs/04-financial-domain-model.md`.

**Later amendment:** Shopping sessions and receipts — `docs/06-shopping-receipts-amendment.md`. No extra nav tab; Add gains “Start shopping” and “Scan a bill.”

**Scope:** Navigation, IA, dashboard hierarchy, screens, flows, wireframes, edge cases, MVP boundary.

**Out of scope:** Visual polish, component library, technical architecture, Safe-to-Spend formula (engine). The UI will *explain* that formula; it will not invent it.

**Repository note:** At the time of this stage, the project folder contained no prior Stage 1/2 artifacts and no application code. This document is derived from the product definition in the Stage 3 brief. Financial rules were not redesigned.

---

## 1. Product UX interpretation

This is not an expense tracker with extra tabs.

It is a **decision system** for one person who already knows their financial life is more than “debit = spend.”

The product has one job:

> Tell me what is happening with my money, and what I can safely do next — without making me keep a second spreadsheet in my head.

### 1.1 The five questions the UI must always be able to answer

| Question | User language | Not this |
|---|---|---|
| What is in the banks/cash right now? | **You have** | Spendable money |
| What of that is already spoken for? | **Reserved** | Budget remaining |
| What can I use without breaking a coming bill? | **Safe to spend** | Bank balance − rent |
| What left my life as consumption? | **You spent** | Any money that left an account |
| Who is mid-settlement, and is that money free? | **People** + reserved consequence | A notes column |

If a screen cannot serve one of these, it is secondary.

### 1.2 Jobs to be done (in priority order)

1. **Decide** — Can I spend? What is due before next salary? Is this risky?
2. **Capture meaning** — Record what actually happened, not a bank debit.
3. **Settle people** — Splits, card-shares, loans, partial/early repayment, and whether incoming money must stay reserved.
4. **Run cards** — Cycle → statement → collect shares → pay issuer.
5. **Review** — Where personal money went this month / this salary period.
6. **Configure** — Accounts, cards, people, salary window, recurring bills. Rare, but accuracy depends on it.

Home is for (1). Capture is for (2). People is for (3). Money is for (4) and balances. Activity + Month Review are for (5). Settings is for (6).

### 1.3 The UX contract: hide the engine, never hide the truth

The engine may have fourteen movement types, three timelines, and reserved-money links.

The UI may not ask the user to think in those types.

| Engine | What the user sees |
|---|---|
| Receivable | **They owe you** / “[Name] owes you ₹X” |
| Payable | **You owe** / “You owe [Name] ₹X” |
| Credit-card liability | **Due on [Card]** / “Still to pay the card” |
| Funding cycle | **This salary period** / **Before next salary** |
| Obligation | **Coming up** |
| Must Pay | **Must pay** |
| Committed | **Protected** |
| Planned | **Planned** (visible, not treated as already reserved) |
| Flexible | Not an obligation in V1 — use **budgets** |
| Internal transfer | **Moved** |
| Credit-card purchase | **Card spend** |
| Credit-card payment | **Card payment** (explicitly not a spend) |
| Settlement received | **[Name] paid you** |
| Money lent | **You lent [Name]** |
| Investment | **Invested** (not spent) |
| Reserved | **Reserved** — this word stays. It is already the user’s word. |

**Safe to spend**, **Reserved**, and **Coming up** are the only product-specific terms we teach. Everything else is plain language.

### 1.4 Three timelines, one screen at a time

The engine keeps:

- spending date (analytics month)
- cash-flow / payment date
- salary-period assignment

The UI does **not** show three date pickers on every screen.

| Screen | Primary time | Other timelines shown as |
|---|---|---|
| Home | Right now + until next salary | “This month spent” as a secondary line |
| Month Review | Calendar month | “Charged this month, due next period” note |
| Coming up | Due date | “Covered by September salary” label |
| Card cycle | Statement / due cycle | Purchase dates on each row |
| Activity | Event date | Cycle and salary-period as metadata |

### 1.5 Capture is a meaning picker, not a category form

If “Add” opens Amount → Category → Save, this product will silently become a generic tracker and the engine will be fed lies.

Capture starts with **what happened**, in human language. The form then asks only the fields that meaning needs.

### 1.6 Conservative headline, honest explanation

Unreceived money never inflates the **Safe to spend** headline.

Expected settlements, planned extras (April/September), and later-cycle card bills appear in the explanation as **not included** lines. The user can still see them. They do not change the number they are being asked to trust.

This is a UX interpretation of “projections must remain conservative.” The exact arithmetic remains an engine deliverable and must be approved separately. See §9.

---

## 2. Recommended navigation

### 2.1 Options considered

| Option | Structure | Why rejected / kept |
|---|---|---|
| A. Generic tracker | Home, Transactions, Budgets, Accounts | Erases People, Cards-as-cycles, Reserved, Safe to spend |
| B. Entity browser | Home, Transactions, Cards, People, Planning, Accounts | Six destinations; Planning is a designer word; Cards vs Accounts is accounting-split |
| C. Job-based (recommended) | **Home, Activity, People, Money** + persistent **Add** | Four places that match how this life is actually run |
| D. Bills as a fifth tab | Home, Activity, People, Coming, Money | Coming is a daily *view*, not a daily *place*. It belongs on Home with a “See all” |

Cards are first-class **inside Money** and on Home (as coming payments). They are not a fifth tab. A fifth tab would force a sixth (“Accounts”) and the bar becomes an entity directory.

### 2.2 Primary navigation

```
Home      What can I safely do next?
Activity  What happened?
People    Who owes whom?
Money     Where is it, and what is attached to it?
```

**Add** is not a tab. It is a persistent action (center button on phone, primary button on desktop).

**Settings** is not a tab. It is a gear on Home / Money.

**Coming up**, **Month Review**, **Safe to spend explanation**, and **Can I spend ₹X?** are first-class *screens*, not first-class *nav items*. They are opened from Home (and from relevant objects).

### 2.3 Why these four names

- **Home** — not “Dashboard.” Dashboard sounds like charts. Home is the decision surface.
- **Activity** — not “Transactions.” A salary arrival, a settlement, a card payment, and a reservation are events with meaning, not a bank dump.
- **People** — the differentiator. If this is buried, the product fails its actual workload.
- **Money** — one umbrella for banks, cash, cards, investments, loans, and reserved. Avoids teaching “asset vs liability account.”

If “Money” feels too soft, the approved alternative is **Accounts**. Do not use both.

### 2.4 Chrome by surface

**Phone (primary)**

```
┌──────────────────────────────────┐
│  [screen]                        │
│                                  │
├──────┬──────┬──────┬──────┬──────┤
│ Home │ Act. │  +   │People│Money │
└──────┴──────┴──────┴──────┴──────┘
```

**Desktop**

```
┌──────────┬─────────────────────────────────┐
│ Home     │  [screen]              [Add]    │
│ Activity │                                 │
│ People   │                                 │
│ Money    │                                 │
│ ───────  │                                 │
│ Settings │                                 │
└──────────┴─────────────────────────────────┘
```

Assumption to confirm: **phone-first**, because capture happens in the world (restaurant, GPay, card SMS). Desktop is for month review and card-cycle reconciliation. See §9.

### 2.5 Global search (V1.1, not V1)

V1 uses in-screen search on Activity and People. Global search across merchants, people, and cycles can wait until there is enough history for it to matter.

---

## 3. Information architecture

### 3.1 Map

```
Home
 ├─ Safe to spend → Explanation
 ├─ You have / Reserved → Money (reserved slice)
 ├─ Can I spend ₹X? → Affordability
 ├─ Alerts → relevant object (cycle / obligation / person)
 ├─ Coming up (3–5) → Coming up (full)
 │    └─ row → Obligation detail / Card cycle
 ├─ This month → Month Review → Category → Activity (filtered)
 └─ People snapshot → People → Person
      └─ Person → item → Activity detail
                → Record a payment (settlement)

Activity
 ├─ Event detail (read / limited edit)
 └─ Add (same as global Add)

People
 └─ Person
      ├─ Open items (card share / shared bill / loan)
      ├─ Reserved because of them
      ├─ Record they paid / you paid
      └─ Event detail

Money
 ├─ Reserved strip → Reserved detail (by obligation)
 ├─ Banks & cash → Account → Activity (filtered)
 ├─ Cards → Card → Cycle → spends / shares / statement / payment
 ├─ Investments → Investment account → Activity
 └─ Loans → Loan → schedule (V1.1) / coming EMI

Settings
 ├─ Banks, cards, cash, investments, loans
 ├─ People
 ├─ Categories
 ├─ Salary window & expected extras
 ├─ Coming-up templates (rent, EMI, insurance, …)
 └─ Budgets (category, month)
```

### 3.2 Home

| | |
|---|---|
| **Purpose** | Answer the ten dashboard questions without cramming. Make the next action obvious. |
| **Shown** | Safe to spend (hero). You have. Reserved. Salary-period status. Alerts (only decision-changing). Next 3–5 coming items. This month personal spend vs last month. People net (they owe / you owe) with top 2 names. |
| **Not shown** | Charts. Full card list. Budget grids. Year trends. Investment performance. |
| **Actions** | Add. Can I spend ₹X?. Open any number. See all coming. See month. See people. |
| **Drills** | Explanation, Coming up, Month Review, Person, Card cycle, Account, Affordability. |
| **Relations** | Read-model over Money, People, Coming up, Activity. Writes nothing except via Add. |

### 3.3 Safe to spend explanation

| | |
|---|---|
| **Purpose** | Make the hero number boringly inspectable. |
| **Shown** | Three groups of line items: **In this number**, **Not in this number (later salary period)**, **Not in this number (not yet received / optional)**. Each line has amount, why, and a link to source. A short method note: conservative; formula version. |
| **Actions** | Open source. Recalculate is automatic. |
| **Rule** | No duplicate of the same card bill as both “liability” and “upcoming payment.” Card impact appears once, as remaining amount to pay the issuer for cycles that affect this period. Total card outstanding across all cycles lives on Money → Cards. |
| **Not this stage** | The arithmetic itself. This screen is a layout contract the engine must fill. |

### 3.4 Affordability (“Can I spend ₹X?”)

| | |
|---|---|
| **Purpose** | Projection with a conclusion, not a yes/no. |
| **Shown** | Amount field. Current safe to spend. Must-pay / protected items before next salary. Remaining after those. Proposed purchase. Buffer. Conclusion in plain language (comfortable / tight / not from current funds). Later-period obligations listed, not subtracted. |
| **Actions** | Change amount. Save as planned purchase (V1.1). Record the spend (if they proceed). |
| **Relations** | Same inputs as Safe to spend + the proposed amount. |

### 3.5 Coming up

| | |
|---|---|
| **Purpose** | Upcoming payments with funding truth. |
| **Shown** | Date, name, amount, from (account/card), salary period, status (Reserved / Partly funded / Needs funding / Uncertain salary window / Paid). Amount still needed. |
| **Filters** | Next 10 days. Until next salary. This salary period. Overdue. All open. |
| **Actions** | Mark paid / record payment. Open cycle. Adjust amount for this instance (does not rewrite past instances). |
| **Relations** | Generated from obligation templates, loan EMIs, and card cycles. Card rows are cycles, not generic bills. |

### 3.6 Activity

| | |
|---|---|
| **Purpose** | The full movement history, with meaning visible on every row. |
| **Row** | Date. Plain-language meaning (“Card spend · split”, “Rahul paid you”, “Invested”). Counterparty or merchant. Amount. Source (HDFC / ICICI •8001). Tiny flags: Reserved, Split, Not your spend. |
| **Filters** | Period (All / Month / Salary period / Custom). Meaning. Person. Account or card. Category. Unsettled only. |
| **Actions** | Search. Add. Open. Edit with historical-safety warning. |
| **Not** | A place to reconcile a card cycle. That is the cycle screen. |

### 3.7 Event detail

Always explain **what changed in the world**, in this order:

1. Meaning in one sentence.
2. Money movement (which account/card, amount).
3. Personal spend (₹0 if not consumption).
4. People effect (who owes / owed).
5. Reserved effect (created / released / none).
6. Cycle / obligation link if any.
7. Notes, channel (GPay, PhonePe, …), metadata.

Channel is a **label** on the event (GPay + HDFC vs GPay + RuPay card). It is not a top-level module.

### 3.8 People

| | |
|---|---|
| **Purpose** | The social ledger. Core module. |
| **List** | Sorted by absolute outstanding. Each row: name, they owe you / you owe them / settled, how much of their debt is already sitting in your bank as reserved, last event. |
| **Sections** | They owe you. You owe them. Settled (collapsed). |
| **Actions** | Add person. Open person. Record a payment from the list (shortcut). |

### 3.9 Person

| | |
|---|---|
| **Purpose** | One relationship, complete enough to settle without a side calculation. |
| **Hero** | Net position in user language. Secondary: “₹X of this is already reserved toward cards.” |
| **Open items** | Grouped: **Card shares** (with cycle and due date), **Shared bills**, **Loans**. Each: share, paid, outstanding. |
| **Activity** | Their events. |
| **Actions** | They paid me. I paid them. Add split. Lend. Borrow. |
| **Settlement sheet** | Amount, destination account, allocation across open items, then a consequence line: how much becomes reserved vs available. User confirms allocation. See §6.4 and §9. |

### 3.10 Money

| | |
|---|---|
| **Purpose** | Where money lives, what is reserved, what cards/loans demand. |
| **Top** | Reserved total, tappable, broken down by destination obligation. |
| **Banks & cash** | Each: name, last4, current balance. Primary salary account marked. |
| **Cards** | Each: name, last4, remaining to pay on current/open cycles, next due date, default owner if not you, utilization optional. |
| **Investments** | Each: name, amount moved in (V1 does not track market value). |
| **Loans** | Each: name, EMI, next due, outstanding principal if entered. |
| **Actions** | Open any. Record opening/adjust balance only via a dated adjustment event (never silent rewrite). |

### 3.11 Card and card cycle

**Card**

- Identity, limit, statement rule, due rule, default owner, active flag.
- List of cycles, current highlighted.
- “Default owner is [Name]” banner when not you (AXIS •6248 case).

**Cycle** (the working screen)

- Window: purchases from → to. Expected statement date. Expected due date.
- Amount: expected vs actual statement (once generated). Paid. Remaining to pay issuer.
- Collected from people / still to collect.
- Reserved toward this cycle / still to fund from your money.
- Ownership split: Yours vs others (sum).
- Every purchase. Never a statement-only total.
- Actions: Confirm statement, record card payment, record collection, open a spend, add spend.

### 3.12 Account (bank / cash)

Balance. Reserved portion on this account if we later support per-account reserved (V1 may keep reserved as a global pool with destination obligation; see §9). Activity. Linked coming payments.

### 3.13 Month Review

Calendar month. **Personal consumption only.**

Excluded from “You spent”: transfers, investments, lending, card payments, others’ shares, refunds, settlements.

Includes: your share of splits, your card spends, your cash/bank expenses.

Show a quiet note: “₹X was charged to cards this month and is due in [month/cycle].”

Drill: category → events.

Comparison: previous calendar month. Not a chart gallery.

Salary-period review is a toggle on the same screen, not a separate product area.

### 3.14 Settings

Configuration that must be historically versioned (effective-from dates): salary expected amount and window, rent, EMI, card statement/due rules, default owners, budgets.

Changing these **must not rewrite past months**. The UI says so at save time: “Applies from [date]. Past months stay as they were.”

---

## 4. Dashboard structure (Home)

Progressive disclosure. Decision first. Analytics last, and mostly elsewhere.

### 4.1 Above the fold (always)

1. **Salary-period context** — one quiet line.  
   Examples: “Before next salary · expected 4–8 Sep” / “Salary not in yet · window 4–8 Aug” / “This period started 5 Aug.”
2. **Safe to spend** — the only large number. Tappable. Caption: “After reserved money and must-pays before next salary.”
3. **You have** and **Reserved** — two smaller numbers, equal weight to each other, lesser than the hero. Tappable.
4. **Actions** — Add. Can I spend ₹X?

Do not put a chart here. Do not put five account balances here.

### 4.2 Alerts (only if true)

Render zero, one, or a few. Never a permanent “inbox.”

| Alert | Tone | Goes to |
|---|---|---|
| Must-pay overdue | Danger | Obligation / cycle |
| Due inside uncertain salary window | Warning | Coming up row |
| Next must-pays exceed safe to spend | Warning | Explanation + Coming up |
| Statement ready to confirm | Info | Cycle |
| Insufficient reserved for a cycle that is due | Warning | Cycle |

Do not alert “Eating out is at 60%.” That is Month Review.

### 4.3 Secondary (immediately below)

**Coming up** — next 3–5 by due date.

Each row: date, name, amount, status chip (Reserved / Needs funding / Uncertain / Paid).

Card bills live **here**, not in a second “Cards” widget. Duplicating them trains the user to ignore one of the lists.

Footer link: See all.

### 4.4 Tertiary (still on Home, not above the fold)

**This month** — one line: “You spent ₹32,400 this month · last month ₹28,100.”  
If a budget is over: a second line, “Eating out over by ₹800.” Tap → Month Review.

**People** — two numbers: “They owe you ₹18,200” / “You owe ₹1,400.”  
Then at most two names with amounts. Tap → People.

No separate “card payments coming” block. No trend sparkline. No net-worth chart.

### 4.5 Explicitly not on Home

- Full bank list
- Investment value
- Year chart
- Every person
- Budget progress for all categories
- Payment-channel stats

Those are drills.

---

## 5. Major screen list

| ID | Screen | V1 | How opened |
|---|---|---|---|
| H1 | Home | Yes | Tab |
| H2 | Safe to spend explanation | Yes | Home hero |
| H3 | Can I spend ₹X? | Yes (simple) | Home action |
| H4 | Coming up (full) | Yes | Home |
| H5 | Obligation instance | Yes | Coming up row |
| A1 | Activity | Yes | Tab |
| A2 | Event detail | Yes | Activity / drills |
| C1 | Capture — meaning picker | Yes | Add |
| C2 | Capture — meaning form | Yes | After C1 |
| P1 | People | Yes | Tab |
| P2 | Person | Yes | P1 / Home |
| P3 | Settlement (they paid / you paid) | Yes | P2 |
| M1 | Money | Yes | Tab |
| M2 | Account (bank/cash) | Yes | M1 |
| M3 | Reserved breakdown | Yes | M1 / Home |
| M4 | Card | Yes | M1 |
| M5 | Card cycle | Yes | M4 / Coming up |
| M6 | Card payment | Yes | M5 |
| M7 | Investment account | Thin | M1 |
| M8 | Loan | Thin | M1 |
| R1 | Month Review | Yes | Home / Activity period |
| R2 | Category in month | Yes | R1 |
| S1 | Settings hub | Yes | Gear |
| S2 | Banks / cards / people / categories | Yes | S1 |
| S3 | Salary window | Yes | S1 |
| S4 | Recurring coming-up templates | Yes | S1 |
| S5 | Budgets | Thin | S1 / R1 |
| — | Loan amortization table | No | — |
| — | Card EMI wizard | No | — |
| — | Year review | No (Activity year filter only) | — |
| — | Investment NAV / returns | No | — |
| — | Statement CSV import | No | — |
| — | Category merge | No | — |
| — | Global search | No | — |

**Thin** means: show the object, record movements against it, do not build an analysis product around it.

---

## 6. Core user flows

Shared rules for all flows:

- Capture states meaning **before** category.
- Every save shows a one-line **consequence** (spend, people, reserved) before or immediately after confirm.
- Back is always safe; nothing saves on swipe-away.
- Historical edits warn if the event is in a confirmed statement or a past month.

### 6.1 Expense (bank / cash)

```
Add → “I spent money”
  → Amount
  → Paid from (HDFC •2581)
  → Channel (GPay, PhonePe, UPI, debit, cash) — optional but available
  → Category / subcategory
  → Merchant / note
  → Date (defaults today)
  → Save
Consequence: Bank −X. You spent X. Reserved unchanged. Nobody owes anybody.
```

View: Activity row “Spent · Grocery” → detail. Month Review includes it.

### 6.2 Credit card (purchase → cycle → statement → payment)

```
Add → “Card spend”
  → Amount, merchant, category, date
  → Card (defaults last-used; AXIS •6248 pre-selects default owner)
  → Owner: Me / [Person] / Split
  → Cycle assigned automatically from card rule; shown as “Goes on statement due 24 Sep”
  → Save
Consequence depends on owner:
  Me:     Card due +X. You spent X.
  Other:  Card due +X. They owe you +X. You spent 0.
  Split:  Card due +X. You spent your share. They owe their shares.
```

Later:

```
Cycle (expected amount running)
  → Statement generated (user confirms actual amount / date)
  → Status: Statement ready
  → Collect shares (if any) — see 6.3 / 6.5
  → Pay card: Add → “Paid a card / bill”
        or Cycle → Pay
        Amount, from account, date, which cycle(s)
  → Remaining to pay issuer ↓
  → Reserved linked to this cycle released up to the payment
```

Purchase month and payment month stay different labels on the same event/cycle. They are never collapsed.

### 6.3 Split (shared transaction → people → receivable → settlement)

```
Add → “We split a bill”
  → Amount, source (bank or card), merchant, category, date
  → People + amounts or equal-split then adjust
  → Your share is explicit, never leftover-implied without showing it
  → Save
Consequence example (card, restaurant ₹6,000; you 2,000; A 2,500; B 1,500):
  Card due +6,000
  You spent 2,000
  A owes 2,500 · B owes 1,500
```

Person A later:

```
Person A → They paid me → ₹2,500 → into HDFC
  → Allocate to the restaurant card-share (suggested)
  → Confirm
Consequence:
  HDFC +2,500
  A outstanding −2,500
  Reserved toward that card cycle +2,500
  Not income
```

### 6.4 Lending (lend → partial repayments → settlement)

```
Add → “I lent money”
  → Amount, person, from account, channel, date, note
  → Save
Consequence: Bank −10,000. They owe you +10,000. You spent 0. Reserved 0.
```

Partial:

```
Person C → They paid me → ₹4,000 → HDFC
  → Allocate to the loan item
  → Confirm
Consequence: Bank +4,000. They owe you −4,000. Available +4,000. Not income.
Remaining loan 6,000.
```

Direct-loan repayment does **not** reserve unless the user links it to an obligation on the settlement sheet (off by default).

### 6.5 Reserved money (early card share → reserve → pay card → release)

This is not a separate “create reservation” verb in V1. Reservation is a **consequence of allocation**.

```
Friend pays ₹10,000 toward upcoming card share
  → Settlement allocated to card-share item(s)
  → Reserved for that cycle +10,000
Home: You have 60,000 · Reserved 10,000 · Safe to spend uses 50,000 as the liquid-available input
  → User pays the card from HDFC
  → Reserved for that cycle released (used)
  → Card remaining to pay issuer ↓
```

If they pay more than open card-shares, the overflow goes to other open items or to available money, as allocated. The consequence line must say so.

### 6.6 Salary (arrival → period begins)

```
Add → “I got paid”
  → Kind: Salary / Other income
  → Amount, into account (defaults primary), date
  → If Salary: “Start this salary period?” (default on if inside or near window)
  → Save
Consequence: Bank +amount. This is income. Period status: started [date].
Home context line switches from “Salary not in yet” to “Period started [date]. Next window [dates].”
```

Expected extras (April / September) are Settings: optional expected window + rough amount. They do **not** increase Safe to spend until recorded (or until a later, approved engine rule says otherwise). Home can show “Extra income usually around now — not counted yet.”

### 6.7 Obligation (upcoming → funding status → payment)

```
Coming up → Rent 18 Aug ₹6,500
  Status: Needs funding | Reserved | Uncertain window | Paid
  → Record payment (from account)
  → Instance marked paid
  → Next month’s instance remains, using the template version effective on that date
```

Card rows in Coming up open the **cycle**, not a generic bill form.

Changing rent going forward: Settings → template → “from [date].” Past paid instances unchanged.

### 6.8 Affordability

```
Home → Can I spend ₹X?
  → Enter 15,000
  → See: safe 31,000; must-pays before next salary; remaining 15,300;
         purchase 15,000; buffer 300
  → Conclusion: “Technically yes, tight before next salary.”
  → Later-period items listed: “Not taken from this number.”
  → Optional: Record spend / Cancel
```

Conclusion copy is templated from buffer bands (to be numerically defined with the formula). UX bands, pending engine:

- Comfortable — buffer clearly above a small cushion
- Tight — technically covered, little left
- Not from current funds — would break must-pays or reserved

Do not use “risky” unless we define it. Prefer **tight**.

### 6.9 Monthly review

```
Home → This month
  → Month Review: personal spent, vs last month, categories
  → Category Eating Out → events
  → Event detail
Period toggle: Calendar month | This salary period
```

### 6.10 Card review

```
Money → Cards → ICICI •8001 → Cycle due 24 Sep
  → Spends, ownership split, collected, reserved, remaining to pay issuer
  → Person row → Person (filtered to this cycle) or event
  → Pay
```

Also reachable: Home → Coming up → that card row.

---

## 7. Text wireframes

Low fidelity. Hierarchy and labels only. Phone width implied; desktop is the same structure with sidebar.

### 7.1 Home

```
┌─────────────────────────────────────────┐
│  Today  ·  Before next salary  4–8 Sep  ⚙ │
│                                         │
│  Safe to spend                          │
│  ₹24,500                          [ › ] │
│  After reserved money and must-pays     │
│  before next salary                     │
│                                         │
│  You have ₹61,200    Reserved ₹12,400   │
│                                         │
│  [ Add ]          [ Can I spend ₹X? ]   │
│                                         │
│  ⚠ IDFC •0430 due 6 Sep — salary may    │
│    not have arrived. Needs ₹3,100       │
│                                         │
│  Coming up                    See all › │
│  18 Aug  Rent              ₹6,500  Need │
│  20 Aug  Loan EMI         ₹15,000  Need │
│  22 Aug  ICICI •8001       ₹4,300  Res. │
│  24 Aug  IDFC •0430        ₹3,100  Unc. │
│                                         │
│  This month                             │
│  You spent ₹32,400  ·  last month ₹28,100│
│  Eating out over by ₹800            ›   │
│                                         │
│  People                                 │
│  They owe you ₹18,200  You owe ₹1,400   │
│  Rahul ₹9,400   Priya ₹6,100        ›   │
└─────────────────────────────────────────┘
```

### 7.2 Safe to spend explanation

```
┌─────────────────────────────────────────┐
│  ←  Safe to spend                       │
│                                         │
│  ₹24,500                                │
│  Conservative. Formula v[pending].      │
│                                         │
│  IN THIS NUMBER                         │
│  You have (banks + cash)     ₹61,200  › │
│  Reserved for card bills    −₹12,400  › │
│  Rent 18 Aug                 −₹6,500  › │
│  Loan EMI 20 Aug            −₹15,000  › │
│  IDFC due inside window      −₹3,100  › │
│                           ────────────  │
│  Safe to spend               ₹24,200*   │
│                                         │
│  NOT IN THIS NUMBER · LATER PERIOD      │
│  ICICI •8001 due 24 Sep      ₹8,000     │
│  Covered by September salary            │
│                                         │
│  NOT IN THIS NUMBER · NOT RECEIVED      │
│  Rahul still owes (card)     ₹6,000     │
│  If it arrives, it will be reserved     │
│  toward ICICI •8001                     │
│                                         │
│  *Illustrative layout only. Exact lines │
│   come from the approved engine formula.│
└─────────────────────────────────────────┘
```

### 7.3 Capture — meaning picker

```
┌─────────────────────────────────────────┐
│  What happened?                    ✕    │
│                                         │
│  I spent money                          │
│  Card spend                             │
│  We split a bill                        │
│  I lent money                           │
│  Someone paid me                        │
│  I got paid                             │
│  I moved money                          │
│  I paid a card / bill / EMI             │
│                                         │
│  Start shopping                         │
│  Scan a bill                            │
│                                         │
│  More                                   │
│  Refund  ·  I borrowed  ·  I paid them  │
└─────────────────────────────────────────┘
```

Eight primary meanings. Two planning/capture shortcuts (shopping, bill scan) — not engine types. Three secondary meanings. Not fourteen engine types.

### 7.4 Capture — split on card

```
┌─────────────────────────────────────────┐
│  ←  We split a bill                     │
│                                         │
│  Amount          ₹6,000                 │
│  When            16 Aug                 │
│  Where           Banoffee               │
│  Paid with       ICICI •8001            │
│  Channel         Card                   │
│  Category        Eating Out             │
│                                         │
│  Split                                  │
│  You             ₹2,000                 │
│  Rahul           ₹2,500                 │
│  Priya           ₹1,500                 │
│  [ + Person ]    [ Equal split ]        │
│                                         │
│  Goes on ICICI statement due 24 Sep     │
│                                         │
│  On save                                │
│  Card due ₹6,000 · You spent ₹2,000     │
│  Rahul owes ₹2,500 · Priya owes ₹1,500  │
│                                         │
│  [ Save ]                               │
└─────────────────────────────────────────┘
```

### 7.5 Settlement

```
┌─────────────────────────────────────────┐
│  ←  Rahul paid you                      │
│                                         │
│  Amount          ₹12,000                │
│  Into            HDFC •2581             │
│  When            Today                  │
│                                         │
│  Put it toward                          │
│  ☑ ICICI •8001 share     ₹7,000  due 24 │
│  ☑ Dinner at Banoffee    ₹2,000  card   │
│  ☑ Direct loan           ₹3,000 of 10,000│
│                                         │
│  ₹12,000 allocated · ₹0 left            │
│                                         │
│  On save                                │
│  HDFC +₹12,000                          │
│  Reserved for cards +₹9,000             │
│  Available +₹3,000                      │
│  Rahul now owes ₹7,000 (loan)           │
│  This is not income                     │
│                                         │
│  [ Confirm ]                            │
└─────────────────────────────────────────┘
```

The consequence block is the product. Allocation without it will be used wrong.

### 7.6 Person

```
┌─────────────────────────────────────────┐
│  ←  Rahul                               │
│                                         │
│  Rahul owes you ₹19,000                 │
│  ₹9,000 of incoming would be reserved   │
│  toward open card bills                 │
│                                         │
│  [ He paid me ]  [ I paid him ]  [ + ]  │
│                                         │
│  Card shares                     ₹7,000 │
│  ICICI •8001  due 24 Sep         ₹7,000 │
│                                         │
│  Shared bills                    ₹2,000 │
│  Banoffee  16 Aug  ICICI         ₹2,000 │
│                                         │
│  Loans                          ₹10,000 │
│  Sent  02 Aug  HDFC / GPay      ₹10,000 │
│                                         │
│  Recent                                 │
│  12 Aug  He paid you ₹0 …               │
└─────────────────────────────────────────┘
```

### 7.7 Card cycle

```
┌─────────────────────────────────────────┐
│  ←  ICICI •8001                         │
│      Cycle due 24 Sep                   │
│                                         │
│  To pay the card          ₹18,400       │
│  Statement  actual ₹18,400 · 12 Sep     │
│  Paid ₹0 · Remaining ₹18,400            │
│                                         │
│  Yours ₹11,400 · Others ₹7,000          │
│  Collected ₹0 · Still to collect ₹7,000 │
│  Reserved ₹0 · You still fund ₹11,400   │
│                                         │
│  [ Confirm statement ]  [ Pay card ]    │
│                                         │
│  Spends                                 │
│  18 Aug  Banoffee   ₹6,000  split  ›    │
│  20 Aug  Fuel       ₹2,400  you    ›    │
│  22 Aug  Amazon     ₹10,000 you    ›    │
└─────────────────────────────────────────┘
```

AXIS •6248 adds a banner: “Spends default to [Friend], not you. Change per spend if needed.”

### 7.8 Money

```
┌─────────────────────────────────────────┐
│  Money                                  │
│                                         │
│  Reserved ₹12,400 toward 2 card bills › │
│                                         │
│  Banks & cash                ₹61,200    │
│  HDFC •2581  salary          ₹48,000    │
│  PNB •6264                   ₹11,800    │
│  Cash                           ₹1,400  │
│                                         │
│  Cards  ·  to pay ₹27,800               │
│  ICICI •8001   due 24 Sep    ₹18,400    │
│  IDFC •0430    due 6 Sep      ₹3,100    │
│  AXIS •6248    Priya’s spends ₹6,300    │
│                                         │
│  Investments                            │
│  Mutual funds   ₹4,500 this period      │
│                                         │
│  Loans                                  │
│  [Loan name]  EMI ₹15,000  due 20 Aug   │
└─────────────────────────────────────────┘
```

### 7.9 Coming up (full)

```
┌─────────────────────────────────────────┐
│  ←  Coming up                           │
│  [ 10 days ] [ Until salary ] [ Period ]│
│                                         │
│  OVERDUE                                │
│  (none)                                 │
│                                         │
│  NEXT 10 DAYS                           │
│  18 Aug  Rent         ₹6,500  Need  HDFC│
│          Must pay · this period         │
│  20 Aug  Loan EMI    ₹15,000  Need  HDFC│
│  22 Aug  ICICI •8001  ₹4,300  Res.      │
│          ₹4,300 reserved · ₹0 to fund   │
│  24 Aug  IDFC •0430   ₹3,100  Uncertain │
│          Due inside salary window       │
│                                         │
│  LATER THIS PERIOD                      │
│  …                                      │
└─────────────────────────────────────────┘
```

### 7.10 Can I spend ₹X?

```
┌─────────────────────────────────────────┐
│  ←  Can I spend this?                   │
│                                         │
│  Amount   ₹15,000                       │
│                                         │
│  Safe to spend now           ₹31,000  › │
│  Rent                        −₹6,500    │
│  ICICI •8001                 −₹8,000    │
│  Insurance                   −₹1,200    │
│                           ────────────  │
│  Left after must-pays        ₹15,300    │
│  This purchase               −₹15,000   │
│  Buffer                         ₹300    │
│                                         │
│  Tight before next salary.              │
│  Covered, with almost nothing left.     │
│                                         │
│  Later, not taken from this number      │
│  HDFC •9225 due 12 Oct        ₹4,000    │
│  Covered by October salary              │
│                                         │
│  [ Record this spend ]                  │
└─────────────────────────────────────────┘
```

Numbers in the affordability example follow the product brief. They are scenario copy, not the approved formula.

### 7.11 Month Review

```
┌─────────────────────────────────────────┐
│  ←  August                              │
│  [ Month ]  [ Salary period ]           │
│                                         │
│  You spent ₹32,400                      │
│  Last month ₹28,100                     │
│                                         │
│  ₹9,200 charged to cards in August      │
│  is due in September.                   │
│                                         │
│  Home          ₹14,200                  │
│  Food           ₹8,400  over budget  ›  │
│  Lifestyle      ₹4,100                  │
│  Transport      ₹3,200                  │
│  Health         ₹2,500                  │
│                                         │
│  Not in “spent”: moved, invested,       │
│  lent, card payments, others’ shares.   │
└─────────────────────────────────────────┘
```

### 7.12 Empty Home (first-run)

```
┌─────────────────────────────────────────┐
│  Home                                   │
│                                         │
│  Safe to spend cannot be trusted        │
│  until balances exist.                  │
│                                         │
│  Set up                                 │
│  1. Add bank accounts + cash            │
│  2. Enter current balances              │
│  3. Add cards + statement / due rules   │
│  4. Add people you settle with          │
│  5. Set salary window                   │
│  6. Add rent, EMI, other must-pays      │
│                                         │
│  [ Start with accounts ]                │
└─────────────────────────────────────────┘
```

Do not show ₹0 as if it were a real Safe to spend.

---

## 8. Important UX edge cases

| State | What the UI does |
|---|---|
| No data / first run | Setup checklist. Hero suppressed or clearly untrusted. |
| Empty Activity after setup | “Nothing recorded yet. Add the first event.” |
| Partial settlement | Item shows paid / share / left. Person hero is net. Chips: Partial. |
| Early settlement | Same sheet; allowed. Cycle may still be open. Reserved can exist before statement. |
| Multiple items, one payment | Allocation sheet required. No silent all-to-one-item. |
| Over-payment vs open items | Show leftover as available (or ask if it is a new loan the other way). Do not hide leftover. |
| Overdue must-pay | Danger on Home and Coming up. Safe to spend still subtracts it until marked paid. |
| Paid obligation | Stays in Coming up under Paid for the current period, then leaves the default filter. |
| Statement not generated | Cycle amount labelled **Expected**. Never look like a confirmed bill. |
| Actual statement in | Label **Statement**. Difference vs expected shown once. |
| Salary not arrived | Home context: “Salary not in yet · window …” Safe to spend does not assume it. |
| Due inside salary window | Chip **Uncertain**. Alert. Conservatively treated as needing current funds (engine must confirm). |
| Insufficient safe balance | Alert + Coming up “Needs funding.” Affordability conclusion “Not from current funds.” |
| Default-owner card (AXIS) | Banner on card and pre-selected owner on capture. Always overridable. Your spend on that card is opt-in per event. |
| Someone’s spend on your card | Activity flag **Not your spend**. Month Review excludes it. People includes it. Cycle includes it in “Others.” |
| Card payment | Activity meaning **Card payment**. Month Review excludes it. Cycle remaining drops. Reserved releases. |
| Refund / reversal | Links to original if known. Reduces spend and/or others’ share as appropriate; user sees the consequence. |
| Transfer / cash out | Not spend. Cash account increases on withdrawal. |
| Investment SIP | Meaning **Invested**. Money moves. Month Review excludes from spent. Optional: still a Planned/Protected coming-up item. |
| Budget vs reserve | Budgets never create Reserved. Overspend is a review warning, not a Safe-to-spend deduction. |
| Month rollover | No reset. No “enter last month’s deficit.” Home just shows current state. Budgets reset per config (V1: reset, no rollover UI). |
| Edit after statement confirmed | Allowed with warning: “This cycle’s statement is confirmed. Changing this spend changes expected vs statement.” |
| Config change (rent, salary, statement date) | “From [date]. History stays.” |
| Reserved after card is fully paid | Should be zero. If leftover reserved exists, surface “Unused reserved ₹X — release to available?” (accuracy issue; do not auto-invent). |
| You owe them (negative person) | Person hero: “You owe Priya ₹1,400.” Action: I paid them. Does not increase Reserved. |

---

## 9. Decisions requiring clarification

These affect UX structure or financial accuracy. Please answer explicitly. Recommendations are stated; they are not implemented.

### 9.1 Blocking for UX sign-off

**D1. Primary device**  
Phone-first (recommended) vs desktop-first vs both equal. This locks chrome (tab bar vs sidebar) and capture.

**D2. Nav label**  
**Money** (recommended) vs **Accounts**. One word. Not both.

**D3. Safe to spend headline policy**  
Confirm: unreceived settlements and expected extra income **never** increase the headline. They only appear under “Not in this number.”  
If you want an optimistic alternate number, it must be labelled **If they pay** and never replace the hero.

**D4. Settlement allocation default**  
When a lump sum covers mixed debts, suggested order needs a rule.  
Recommended suggestion (user can always edit):

1. Card-linked shares, earliest due cycle first  
2. Other shared bills  
3. Direct loans  

This is a financial rule, not just UI sugar, because (1) creates Reserved and (3) usually does not. **Do not implement until approved.**

**D5. Opening position**  
Day-1 needs current bank/cash balances, card remaining-to-pay, and people outstanding. Confirm a dated **Opening** event (or set of events) during setup. Without this, Home cannot be honest.

**D6. “You spent this month” definition**  
Recommended: calendar month, personal consumption only (your shares; not others’ card spend, not transfers, not investments, not lending, not card payments, not settlements). Card purchases count in the purchase month.

### 9.2 Blocking for the engine, but UX is already assuming a shape

**D7. Safe to spend formula**  
Not defined in this repository. Stage 3 only specified the **explanation layout** (in / later period / not received). Formula, versioning, and double-count rules need a dedicated engine spec before this screen can be truthful.

**D8. Uncertain salary window**  
Confirm: obligations due on a date that falls inside the expected income window are treated as needing **current** funds, with a warning — not assumed covered by salary.

**D9. Reserved location**  
Is reserved a global pool tagged to an obligation, or must it sit on a specific bank account? UX can show either. Per-account reserved is more accurate if collections land in HDFC but you might pay a card from PNB. Recommendation: V1 global-by-obligation, with the receiving account displayed; per-account reserved in V1.1 if needed.

**D10. Leftover reserved after card payment**  
If collected shares exceed what you pay the issuer this time, what happens? Ask to release vs keep for the next cycle. Do not auto-keep silently.

### 9.3 Non-blocking preferences

**D11. Cash** — one first-class Cash account (recommended) vs ignore until used.

**D12. Channel list** — GPay, PhonePe, UPI, RuPay-on-UPI, Card, ATM, Cash. Editable list. Not a module.

**D13. Past-event edits** — allow with warnings (recommended) vs lock events on confirmed statements.

**D14. Affordability copy** — Comfortable / Tight / Not from current funds (recommended) vs your preferred words.

**D15. Extra income (April / September)** — V1: remind on Home in those months, count only when recorded.

---

## 10. Recommended MVP boundary

### 10.1 V1 is successful when

A real month can be run **without a side spreadsheet**, including:

- Recording spend, card spend, splits, lending, collections, salary, transfers, investments, card payments, bill payments
- Seeing Have / Reserved / Safe to spend, and opening the explanation
- Seeing coming must-pays with funding status and uncertain-window warnings
- Settling one person across card-share + loan in a single payment, with reserved vs available shown
- Reviewing a card cycle (every spend, yours vs others, remaining to pay)
- Reviewing a calendar month of **personal** spend
- Changing rent or salary **from a date** without rewriting the past

### 10.2 In V1 (product)

- Navigation and screens in §5 marked Yes
- Meaning-first capture (8+3)
- People ledger + allocation settlement
- Reserved as a consequence of card-linked allocation
- Card cycles with expected vs actual statement
- Default transaction owner per card
- Coming up from templates + cycles + EMIs
- Salary window + actual arrival
- Conservative Safe to spend explanation (once formula is approved)
- Simple Can I spend ₹X?
- Month Review (personal consumption)
- Setup / opening positions
- Categories with rename + archive
- Budgets as category targets (no reservation, no rollover)
- Channel as a tag
- Historical-safety warnings on config and on statement-linked edits

### 10.3 V1 thin (object exists, product does not)

- Investments: “moved to MF/PF,” no NAV
- Loans: name, EMI, due day, outstanding number you maintain, coming EMI in Coming up — no amortization engine UI
- Card EMI: do not block the data model later; no wizard now (none exist today)
- Rare banks/cards: supported because they are just accounts/cards, not special cases

### 10.4 Not V1 (and why)

| Requirement | Why it waits |
|---|---|
| Full loan principal/interest split and schedule UI | Safe to spend needs EMI amount + due date + outstanding, not an amortization table. High accuracy cost if built on guessed schedules. |
| Card EMI management UI | No current EMI. Keep the model extensible; do not build the product surface. |
| Budget rollover | Extra policy with no current stated need. V1 resets. |
| Category merge | Archive + recategorize events is enough. Merge is a data-rewrite tool. |
| Week / last-3-months / year as first-class reviews | Month + salary period + Activity filters cover decisions. Year is a later review mode. |
| Flexible obligations | Overlaps budgets. Two systems for eating-out would confuse reservation vs target. |
| Investment performance | Different product. Outflow vs consumption is the V1 distinction. |
| SMS / CSV / bank import | Meaning-first capture must work before we automate misclassification. |
| Payment-channel directory as a module | Tag is enough to distinguish GPay+HDFC vs GPay+RuPay. |
| Global search, net-worth, charts | Decision surface first. |
| Optimistic Safe to spend | Violates conservative headline unless it is a clearly named alternate. |
| Multi-user / household login | Personal-use app. |
| “Create reservation” as a standalone verb | Reservations should come from allocation, or they will drift from people/card truth. |

### 10.5 Complexity to keep (do not “simplify away”)

These look expensive. They are the product.

- Meaning ≠ debit/credit
- People ledger with mixed open items
- Settlement allocation (reserved vs available)
- Card cycles with every spend and default owners
- Three timelines (shown one at a time)
- Salary window vs calendar month
- Reserved money
- Explainable Safe to spend
- Historical versioning of config

Cutting any of these in V1 produces a generic tracker.

---

## 11. Assumptions used in this stage

1. Single user, personal use, India, ₹, English UI, Indian digit grouping.
2. Phone-first unless D1 says otherwise.
3. Manual capture in V1.
4. AXIS •6248-style default owner is a card setting, not a one-off flag.
5. Cash is one account.
6. No financial rule in the brief was changed. Where the brief left a formula unspecified, the UI specifies an explanation contract only.
7. “Flexible” obligations are expressed as budgets in V1, not as a fourth coming-up class.

---

## 12. Approval checkpoint

Please review and explicitly approve or amend:

1. Four-tab navigation + persistent Add  
2. Home hierarchy in §4  
3. Meaning-first capture list in §7.3  
4. Settlement consequence pattern in §7.5  
5. MVP boundary in §10  
6. Answers to D1–D6 (and D7 when the engine spec exists)

No screens will be built until this stage is approved.
