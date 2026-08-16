# Stage 4 — Financial Domain Model & Safe-to-Spend Engine

**Status:** Approved 2026-08-16 with three corrections applied (posting conservation, delayed salary, Q2 horizon). Do not implement database, schema, or application UI yet.

**Depends on:** Stage 3 IA/UX, approved with amendments (2026-08-16).

**Related amendment:** Shopping/receipts planning data and multi-category lines on one event — `docs/06-shopping-receipts-amendment.md`. Does not change Safe-to-Spend.

**This document is the source of truth for financial behaviour.** Physical tables, frameworks, and screen code come after approval. Record shapes below are conceptual. They may be normalized differently in Stage 5 if the behaviour is preserved.

Amounts are conceptually **integer paise**. Prose uses rupees for readability.

---

## 0. Design principles

1. **One user action → one FinancialEvent → many postings + optional holds.** Deterministic. No silent second events.
2. **Balances are derived from postings + openings.** Person net is derived from Claims. Do not store an independently editable “person balance.”
3. **Reserved money is a hold, not a ledger account.** It does not move cash. It restricts which cash may be spent. Holds are **account-scoped and obligation-linked.**
4. **Consumption ≠ cash outflow.** Reporting “You spent” is a classified subset of events, not “money left a bank.”
5. **Unreceived claims never increase Safe to Spend.**
6. **Suggestion ≠ decision.** Settlement allocation may be suggested; the user confirms. The engine never silently assigns mixed money.
7. **History is append-only facts + effective-dated config.** Changing next year’s salary does not rewrite last year’s events or reports.
8. **Explainability is part of the API.** Every number on Home has a line in `explanationItems`.

---

## 1. Proposed domain model

### 1.1 What exists, and why

| Concept | Kind | Why it exists |
|---|---|---|
| **Account** | Entity | Bank, cash, or investment holding. Holds a derived balance. Source of reservations. |
| **CreditCard** | Entity | Different lifecycle from a bank: cycles, statement rules, default owner, limit. |
| **Loan** | Entity | Outstanding principal, EMI, tenure — not a billing cycle. |
| **Person** | Entity | Counterparty. No stored running balance. |
| **Category** | Entity | Nested, renameable, archivable. Used for consumption and budgets. |
| **FinancialEvent** | Entity | The user-facing fact (“what happened”). Header only. |
| **Posting** | Entity | Atomic signed effect on one instrument or P&L bucket. Source of all balances. |
| **Claim** | Entity | One open item with a person (card share, shared bill, loan, borrowing, opening, surplus payable). Subledger of receivable/payable. |
| **EventShare** | Value object | Intended split on the originating event (you / others). Immutable snapshot. Claims are created from these. |
| **SettlementAllocation** | Entity | Confirmed application of a settlement event to one or more Claims. |
| **Reservation** | Entity | Hold: amount remaining on **one Account**, linked to **one obligation**. |
| **SurplusCase** | Entity | Ambiguous leftover (reservation excess or claim overpayment). Must be resolved. Never auto-available. |
| **BillingCycle** | Entity | One card statement window. Statement expected/actual live here — not a separate Statement entity. |
| **ObligationTemplate** | Entity | Effective-dated recurring rule (rent, insurance, SIP, family, …). |
| **ObligationInstance** | Entity | One due occurrence, amount snapshotted. |
| **IncomePolicy** | Entity | Effective-dated expected salary amount + window (e.g. 4th–8th). |
| **FundingCycle** | Entity | One salary period instance (expected window, actual arrival, status). |
| **Budget** | Entity | Category target for a calendar period. Never a hold. |
| **OpeningPosition** | Entity | Dated starting state per instrument/person/loan. Not fake history. |
| **ConfigVersion** | Entity | Catch-all effective-dated settings (card statement day, due rule, default owner, …). |
| **PaymentChannel** | Reference list | GPay, PhonePe, UPI, … A tag on the event, not a balance-bearing entity. |

### 1.2 Challenged and rejected as first-class entities

| Suggested | Decision |
|---|---|
| Receivable / Payable tables | Folded into **Claim** with `direction`. One subledger. |
| Split | **EventShare** on the event. Not its own aggregate. |
| CardStatement | Fields on **BillingCycle** (`expected*` / `actual*`). |
| Transaction vs FinancialEvent | One name: **FinancialEvent**. |
| TransactionLeg | Named **Posting**. |
| Investment | **Account** with `kind = investment`. V1 has no NAV entity. |
| Global reserved pool | Aggregate view only. Source of truth is per-account **Reservation**. |
| IncomeSchedule as well as IncomePolicy | **IncomePolicy** (rule) + **FundingCycle** (instance). |
| Manual Reservation verb | Not an entity. Reservations are created by confirmed card-linked allocations (and guarded corrections). |
| Flexible Obligation class | V1: **Budget**, not an obligation. See Stage 3. |

### 1.3 Account

```
Account
  id
  kind: bank | cash | investment
  displayName            // "HDFC"
  mask                   // "2581"
  isPrimarySalaryAccount
  status: active | archived
  openingPositionId
```

Derived: `balance`, `reservedActive`, `available = balance - reservedActive`.

Investment accounts receive **investment** postings (not expense). Market value is out of V1.

### 1.4 CreditCard

```
CreditCard
  id
  displayName, issuer, mask
  creditLimit            // optional in V1
  defaultOwnerPersonId   // null = user; AXIS •6248 → friend
  status: active | inactive
```

Statement/due rules are **ConfigVersion** rows (`card.statement_day`, `card.due_rule`) so they can change without rewriting past cycles. Each **BillingCycle** snapshots the rules used to build it.

### 1.5 Loan

```
Loan
  id
  name
  currentOutstandingPrincipal   // derived from opening + principal postings, or maintained with dated adjustments
  currentEmi                    // from ConfigVersion / template
  remainingInstallments         // opening + decrements
  nextDueDate
```

V1 does not require a full amortization table. EMI due dates generate **ObligationInstances** with priority Must Pay. See §12 for interest vs principal.

### 1.6 Person

```
Person
  id
  name
  status: active | archived
  notes
```

Derived:

```
theyOweYou  = sum(open Claims where direction = they_owe_user)
youOweThem  = sum(open Claims where direction = user_owes_them)
net         = theyOweYou - youOweThem
```

UI: positive net → “Rahul owes you”; negative → “You owe Rahul”.

### 1.7 Category

```
Category
  id, parentId, name, archivedAt
```

Merge is not V1. Recategorize events instead.

### 1.8 FinancialEvent

```
FinancialEvent
  id
  meaning            // see §3.2 — user intent, not GL name
  occurredOn         // the real-world date (local calendar)
  capturedAt
  amount             // header total; must equal the primary movement
  accountId          // nullable — bank/cash/investment involved
  creditCardId       // nullable
  loanId             // nullable
  billingCycleId     // nullable, assigned for card spends
  channel            // GPay | PhonePe | UPI | card | ATM | cash | ...
  merchant, notes
  categoryId         // nullable
  fundingCycleId     // derived from occurredOn / due context; stored for query stability once assigned
  reversalOfEventId  // nullable
  isOpening          // false — openings are OpeningPosition, not events
```

The header is not the accounting. **Postings are.**

### 1.9 Posting

```
Posting
  id
  eventId
  amount             // signed integer paise
  target:
    accountId        // XOR
    creditCardId
    loanId
    pnl: income_salary | income_other | expense | investment
  categoryId         // when pnl = expense
  claimId            // when this posting opens/reduces a claim
  billingCycleId     // when it affects a cycle
```

Sign convention (`+` = increase of that concept):

| Target | `+` means |
|---|---|
| Account | more money in that account |
| Credit card | more owed to the issuer |
| Loan | more outstanding principal |
| Claim (via claimId) | larger open amount in the claim’s direction |
| pnl/expense | more personal consumption |
| pnl/income_* | more income |
| pnl/investment | contribution classified (paired with the investment-account posting) |

V1 does **not** use classical debit/credit. Signed postings on an event are **not** required to sum to zero. Salary is Account +79,200 and Income +79,200; that is valid. Validation is **per-meaning conservation** (§3.3), not a global zero-sum.

### 1.10 Claim

```
Claim
  id
  personId
  direction          // they_owe_user | user_owes_them
  kind               // card_share | shared_bill | direct_loan | borrowing | opening | surplus_payable
  originalAmount
  originatingEventId
  billingCycleId     // when kind = card_share
  obligationRef      // optional, for linking
  note
  status             // open | settled | void
```

`openAmount` is derived:

```
openAmount = originalAmount
           - sum(SettlementAllocations to this claim)
           + signed adjustments (refunds, corrections)
```

Never edit `openAmount` as a raw field.

### 1.11 SettlementAllocation

```
SettlementAllocation
  id
  eventId              // the "someone paid me" / "I paid them" event
  claimId
  amount               // confirmed by user
  createsReservation   // true when claim is card-linked (kind = card_share, or shared_bill on a still-unpaid cycle)
  reservationId        // set if a hold was created
```

Allocations on a settlement event must sum to the received/paid amount, or the remainder becomes a **SurplusCase** (overpayment) — it must not vanish and must not silently become available cash belonging to the user.

### 1.12 Reservation

```
Reservation
  id
  sourceAccountId      // REQUIRED — where the cash sits
  amountOriginal
  amountConsumed       // used when paying the linked obligation from this account
  amountReleased       // purpose fulfilled without consuming (e.g. paid from another account)
  amountReassigned     // moved to another obligation via surplus resolution
  amountSurplusHeld    // parked in SurplusCase, still not spendable
  status               // active | consumed | released | surplus_pending | reassigned | cancelled
  obligationRef        // { type: billing_cycle | obligation_instance, id }
  originatingEventId
  originatingClaimId
  createdOn
```

```
remaining = original - consumed - released - reassigned - surplusHeld
```

Global reserved total = sum of `remaining` where status is `active` or `surplus_pending` (surplus is still not spendable).

### 1.13 SurplusCase

```
SurplusCase
  id
  amount
  kind               // reservation_excess | unallocated_settlement | claim_overpayment
  sourceAccountId    // where the cash is, if already received
  personId           // if known
  reservationId      // if kind = reservation_excess
  eventId
  explanation        // generated, plain language
  status             // pending | resolved
  resolution         // see §8.4
  resolvedAt, resolvedByEventId
```

Until resolved, the amount is **not** in `available` and **not** the user’s Safe to Spend.

### 1.14 BillingCycle

```
BillingCycle
  id
  creditCardId
  purchaseWindowStart, purchaseWindowEnd
  expectedStatementDate, actualStatementDate
  expectedDueDate, actualDueDate
  expectedAmount         // derived: openingUnbilled + spends - refunds in window
  actualStatementAmount  // user-confirmed; null until statement exists
  amountPaid
  status                 // open | statement_expected | statement_confirmed | due | paid | closed
  fundingCycleId         // assigned from due date (§7)
  ruleSnapshot           // statement day, due rule used
```

Derived:

```
remainingToIssuer = (actualStatementAmount ?? expectedAmount) - amountPaid
reservedForCycle  = sum(Reservation.remaining where obligationRef = this cycle)
unfundedByUser    = max(0, remainingToIssuer - reservedForCycle)
```

`unfundedByUser` is what Safe to Spend may subtract when this cycle is in the current inclusion set. Do **not** also subtract `remainingToIssuer`.

### 1.15 ObligationTemplate & ObligationInstance

```
ObligationTemplate
  id
  name                   // "Rent"
  priority               // must_pay | committed | planned
  amount                 // current version via ConfigVersion / own effective dates
  dueRule
  defaultAccountId
  creditCardId           // null — card bills are BillingCycles, not templates
  loanId                 // set for EMI templates
  effectiveFrom, effectiveTo
```

```
ObligationInstance
  id
  templateId             // null if one-off
  dueOn
  amount                 // snapshot
  prioritySnapshot
  status                 // open | paid | skipped
  fundingCycleId
  paidEventId
```

Card bills are **BillingCycles**, not ObligationInstances. Coming up is a **union view** over instances + cycles + loan EMIs.

### 1.16 IncomePolicy & FundingCycle

```
IncomePolicy
  id
  expectedAmount
  windowStartDay         // 4
  windowEndDay           // 8
  typicalDay             // 5, display only
  effectiveFrom, effectiveTo
```

Extra income (April / September) is a separate optional policy or one-off expected item. It does **not** count as reliable income until received (D3 analogue for income).

```
FundingCycle
  id
  year, month            // the month of the expected window
  expectedWindowStart    // date
  expectedWindowEnd
  expectedAmountSnapshot
  actualArrivalOn        // null until salary event
  actualAmount
  salaryEventId
  status                 // upcoming | window_open_unreceived | salary_delayed | active | closed
```

**Active cycle** = the latest cycle whose salary has actually arrived. Until September salary arrives, August remains active for current-cycle Safe to Spend.

**`salary_delayed`** = `asOf > expectedWindowEnd` and `actualArrivalOn` is still null. See §4.5. This is not `window_open_unreceived` and not `upcoming`. Q1 must not keep treating post-window bills as funded by the missing salary.

### 1.17 Budget

```
Budget
  categoryId
  calendarYear, calendarMonth
  amount
  rollover: none         // V1
```

Never creates a Reservation. Never subtracted in Safe to Spend.

### 1.18 OpeningPosition

Dated starting facts. Not FinancialEvents, so they cannot be mistaken for activity inside the app.

```
OpeningPosition
  id
  effectiveOn
  target:
    account: { accountId, balance }
    creditCard: {
      creditCardId
      currentOutstanding      // total owed to issuer now
      currentStatementBalance // nullable
      unbilledAmount          // nullable; if omitted, derive: outstanding - statement
      statementDate, dueDate  // for the open cycle, if known
    }
    person: { personId, direction, amount, note }
    loan: {
      loanId
      outstandingPrincipal
      remainingTenure
      currentEmi
      nextDueOn
    }
```

Effects: seed derived balances and, for cards, seed the **current BillingCycle** without fabricating merchants. Person openings create one **Claim** of kind `opening`.

---

## 2. Entity relationships

```
IncomePolicy ──generates──► FundingCycle
ObligationTemplate ──generates──► ObligationInstance ──assigned──► FundingCycle

Account ◄──source── Reservation ──links──► BillingCycle OR ObligationInstance
Account ◄──postings── Posting ◄── FinancialEvent
CreditCard ──has── BillingCycle ◄── Posting (spends, payments, refunds)
CreditCard ──defaultOwner── Person

Person ──has── Claim ◄── SettlementAllocation ◄── FinancialEvent (settlement)
Claim ──may create── Reservation
Claim ──may originate── SurplusCase

Loan ──generates EMI── ObligationInstance
OpeningPosition ──seeds── Account | BillingCycle | Claim | Loan

Category ◄── Posting (expense)  Budget
```

Coming up (read model):

```
ComingUpItem = ObligationInstance | BillingCycle remaining
  + dueOn
  + fundingCycleId
  + reservedAmount (sum of linked reservations)
  + unfundedAmount
  + uncertainWindowFlag
```

---

## 3. Financial event model

### 3.1 How one action hits many concepts without double counting

A FinancialEvent is a **template of postings + holds**. Each concept is updated by exactly one class of posting/hold:

| Concept | Updated by |
|---|---|
| Bank/cash/investment balance | Account postings |
| Card owed to issuer | Credit-card postings on a cycle |
| Loan outstanding | Loan postings |
| Person net | Claim original ± allocations |
| Personal consumption | `pnl = expense` postings only |
| Income | `pnl = income_*` only |
| Reserved | Reservation rows, not postings |
| Safe to Spend | Derived; never stored on the event |

If two lines would represent the same rupee (e.g. subtract card remaining **and** reserved for that same cycle), the Safe-to-Spend formula forbids it (§4.6).

### 3.2 Meanings (capture intents)

| Meaning | Engine key |
|---|---|
| I spent money | `spend_account` |
| Card spend | `spend_card` |
| We split a bill | `split` |
| I lent money | `lend` |
| Someone paid me | `settlement_in` |
| I got paid | `income` |
| I moved money | `transfer` |
| I paid a card / bill / EMI | `pay_obligation` |
| Refund | `refund` |
| I borrowed | `borrow` |
| I paid someone | `settlement_out` |

### 3.3 Posting templates and conservation

Signs follow §1.9 (`+` = increase of that target). P&L postings (`income_*`, `expense`, `investment`) are **classifications**, not contra-entries. Do not require `sum(posting.amount) == 0`.

Validate each event with the identity for its `meaning`. Amounts compared as absolute magnitudes of the conserved movement.

| Meaning | Conservation (must hold) |
|---|---|
| `spend_account` | account decrease = personal expense (**sum of expense postings on the event**, if multiple categories) |
| `spend_card` (mine) | card liability increase = personal expense (same sum rule) |
| `spend_card` (other owner) | card liability increase = new `they_owe_user` claims |
| `split` on card | card liability increase = personal expense + new claims |
| `split` on bank/cash | account decrease = personal expense + new claims |
| `lend` | account decrease = receivable claim increase |
| `borrow` | account increase = payable claim increase |
| `settlement_in` | account increase = sum(claim decreases) + pending surplus (if any) |
| `settlement_out` | account decrease = sum(payable claim decreases) + pending surplus (if any) |
| `income` | account increase = income classification |
| `transfer` (own accounts, incl. cash withdrawal) | source decrease = destination increase; expense = 0; income = 0 |
| `pay_obligation` (card) | account decrease = card liability decrease |
| `pay_obligation` (bill / EMI with no interest split) | account decrease = instance remaining decrease (EMI also reduces loan outstanding by the same amount in V1) |
| `refund` | reverse the original meaning’s conservation for the refunded user share / claim / card |
| investment move (`transfer` onto `kind=investment`, or equivalent) | bank/cash decrease = investment account increase; expense = 0 |

Reservations are holds, not postings. They do not participate in conservation identities. `settlement_in` that creates a hold still conserves **account increase = claim decrease**; the hold only restricts availability.

An event that fails its row is invalid and must not commit.

---

Signs shown below are user-facing effects. Templates must satisfy the table above.

#### A. Restaurant ₹6,000 on ICICI •8001 — you ₹2,000, Rahul ₹4,000

`meaning = split`, `creditCardId = ICICI`, EventShares: You 2000, Rahul 4000.

| Posting | Target | Amount |
|---|---|---|
| 1 | Credit card / cycle | +6,000 liability |
| 2 | Claim Rahul `card_share` | +4,000 |
| 3 | pnl/expense Eating Out | +2,000 |

Bank: unchanged. Income: 0. Reserved: 0.

Identity: `card_delta = personal_expense + new_receivables` → 6000 = 2000 + 4000.

If paid from HDFC instead of card: posting 1 is Account HDFC −6,000 instead of card +6,000. Claims and expense unchanged. Then this is not a card-share (no cycle); claims are `shared_bill`. **No reservation** on later collection unless the user links it to another unpaid obligation (default: collection of a non-card shared bill is available money — the expense already left the bank).

#### B. Personal card spend ₹2,400

| Posting | Amount |
|---|---|
| Card / cycle | +2,400 |
| pnl/expense | +2,400 |

#### C. Friend’s spend on AXIS (default owner)

Same as B but expense 0, Claim friend `card_share` +full amount. Default owner preselected, editable.

#### D. Salary ₹79,200 into HDFC

| Posting | Amount |
|---|---|
| HDFC | +79,200 |
| pnl/income_salary | +79,200 |

Sets `FundingCycle.actualArrivalOn`. Cycle status → `active`. Previous cycle → `closed`. Conservation: account increase = income classification. Valid even though both signed amounts are positive.

#### E. Grocery ₹900 HDFC / GPay

| HDFC | −900 |
| pnl/expense Grocery | +900 |

Cannot exceed **available** on HDFC (balance − reserved).

#### F. Transfer HDFC → PNB ₹5,000

| PNB | +5,000 |
| HDFC | −5,000 |

Conservation: source decrease = destination increase. Income 0, expense 0. Reserved on HDFC cannot be transferred away; only `available` may move. (If the user must move reserved cash, they resolve/release first.)

#### G. Cash withdrawal ₹2,000 PNB ATM

| Cash | +2,000 |
| PNB | −2,000 |

Conservation: source decrease = destination increase. Not expense.

#### H. Invest ₹4,500 HDFC → MF

| MF account | +4,500 |
| HDFC | −4,500 |
| pnl/investment | +4,500 (classification only; not part of a zero-sum) |

Conservation: bank decrease = investment account increase. Expense 0. The classification amount must equal the movement.

#### I. Lend ₹10,000 HDFC to Rahul

| HDFC | −10,000 |
| Claim `direct_loan` | +10,000 |

Expense 0. No reservation.

#### J. Rahul pays ₹4,000 toward that loan into HDFC

User confirms allocation to the loan claim.

| HDFC | +4,000 |
| Claim | −4,000 |

Income 0. Reservation 0. Available +4,000.

#### K. Rahul pays ₹12,000 mixed — user confirms: card 7,000, dinner 2,000, loan 3,000

Dinner was on card (still unpaid cycle) → card-linked. Loan is not.

| HDFC | +12,000 |
| Claim card_share | −7,000 |
| Claim shared_bill/card_share dinner | −2,000 |
| Claim direct_loan | −3,000 |
| Reservation HDFC → ICICI cycle | +9,000 remaining |

Income 0. Available +3,000. Reserved +9,000.

Engine **suggests** this order (card-linked earliest due, then other bills, then loans) but stores nothing until confirm (D4).

#### L. Pay ICICI ₹18,400 from HDFC (₹9,000 reserved for that cycle)

| HDFC | −18,400 |
| Card cycle | −18,400 remaining to issuer |
| Reservation | consume 9,000 |

The ₹9,400 extra must come from HDFC **available**. If available < 9,400, the payment is invalid (or must split across accounts).

#### M. Refund of a personal card spend

Reverses card liability and expense (or remaining claim if it was someone else’s spend). Links `reversalOfEventId`.

### 3.4 Consequence preview (approved UX, engine contract)

Before commit, the engine returns `ConsequencePreview`:

```
effects[]: { account, delta } | { card, delta } | { person, delta } | { reserved, delta, account, obligation }
classifications: { spent, income, invested, moved }
warnings[]: e.g. uses uncertain window; exceeds available
narrative: plain-language lines matching Stage 3
```

Nothing is persisted until confirm.

### 3.5 Three dates on every card spend (never collapsed)

| Field | Source | Used for |
|---|---|---|
| `occurredOn` | User / import | Spending month, Activity |
| `billingCycleId` | Card rule on `occurredOn` | Cycle screen, expected statement |
| `expectedDueDate` | Cycle | Coming up, cash-flow month |
| `fundingCycleId` | Due date vs salary calendar (§7) | STS inclusion, “covered by September salary” |

---

## 4. Safe-to-Spend specification

Home hero is **current-cycle Safe to Spend**. It is not “bank − bills” naively, and it is not available liquid alone.

### 4.1 Two different questions

| ID | Question | API |
|---|---|---|
| **Q1** | How much can I safely spend **before my next reliable income**? | `evaluateSafeToSpend(asOf)` → `currentCycleSafeToSpend` |
| **Q2** | If I spend ₹X **today**, do **upcoming** salary cycles in the proposal’s horizon stay healthy? | `simulateAffordability(asOf, proposal)` |

Q1 is the headline. Q2 is “Can I spend ₹X?”. A purchase can pass Q1 and fail Q2.

### 4.2 Domain API (conceptual)

```
SafeToSpendSnapshot
  asOf
  activeFundingCycleId
  nextFundingCycleId

  accounts: AccountLiquidity[]
    accountId
    balance
    reservedRemaining
    available              // balance - reservedRemaining; never count surplus as available

  liquidTotal              // sum of bank+cash balances (not investments)
  reservedTotal            // sum of reservation remaining + pending surplus on those accounts
  availableLiquid          // sum of account.available  == liquidTotal - reservedTotal
                           // (under the invariant reserved <= balance per account)

  includedObligations: ObligationImpact[]     // subtracted
  includedObligationsTotal                    // sum of unfunded
  uncertainWindowItems: ObligationImpact[]    // subset of included, flagged

  currentCycleSafeToSpend  // availableLiquid - includedObligationsTotal
                           // floor not applied silently; if negative, keep negative and set risk

  excludedFutureObligations: ObligationImpact[]   // NOT subtracted
  unreceivedClaimsTotal                           // NEVER added; listed for “owed to you”
  plannedNotSubtracted: ObligationImpact[]        // Planned SIPs etc.
  budgetsIgnored: { category, spent, target }[]   // visibility only

  nextExpectedIncomeWindow: { start, end, status, expectedAmount }
  delayedFundingCycleIds[]     // cycles in salary_delayed; empty if none
  nextCycleProjection: CycleProjection            // immediate next; Q2 may project further (§5)
  riskFlags[]                  // includes expected_income_delayed when any cycle is salary_delayed
  explanationItems[]
```

```
ObligationImpact
  ref                  // cycle or instance
  name, dueOn
  grossRemaining       // remaining to pay the counterparty (issuer / landlord / bank)
  reservedLinked
  unfunded             // max(0, grossRemaining - reservedLinked)
  fundingCycleId
  uncertainWindow: bool
  priority             // must_pay | committed
  includeInCurrentCycle: bool
```

```
CycleProjection
  fundingCycleId
  openingAvailableEstimate
  expectedIncome
  includedUnfunded
  projectedSafeToSpend
```

Do not persist Safe to Spend. Recompute.

### 4.3 A. Current liquid funds

```
liquidTotal = Σ balance(account) where kind ∈ { bank, cash }
```

Investments are **not** liquid. Credit-card “available credit” is **not** liquid.

### 4.4 B. Reserved funds

```
reservedTotal = Σ reservation.remaining  [status active]
              + Σ SurplusCase.amount     [pending, cash already in an account]
```

Per account:

```
available(account) = balance(account) - reservedOn(account) - pendingSurplusOn(account)
```

Invariant: `reservedOn(account) + pendingSurplusOn(account) ≤ balance(account)`. Violation is an **invalid state**, surfaced, not ignored.

### 4.5 C–E. Which obligations hit Q1

**Next reliable income** = actual arrival of the next salary event. Expected window dates are not reliable income.

Until that event exists:

- The **active** funding cycle is the last one with an actual arrival (e.g. August).
- The **next** cycle is the upcoming window (e.g. 4–8 Sep), while `asOf <= expectedWindowEnd` and salary is unreceived (`window_open_unreceived` once the window has started).

#### Normal (window not yet failed)

**Include in Q1** (subtract `unfunded`) an item if it is Must Pay or Committed, unpaid, **and** any of:

1. Assigned to the **active** funding cycle; or
2. `dueOn <= asOf` (overdue); or
3. Due on or before `next.expectedWindowStart − 1 day`; or
4. Due **inside** `next.expectedWindow` **and** `next.actualArrival` is null (**uncertain window** — D8). Flag `uncertainWindow`.

**Exclude from Q1** (list under future) while the next window has **not** failed:

- Due after `next.expectedWindowEnd` (e.g. 24 Sep when window is 4–8 Sep and today is 20 Aug or 6 Sep).
- Planned priority, Flexible / budgets, unreceived claims.

Once September salary **arrives**, September becomes active. Items due 6 Sep and 24 Sep that belong to September **enter Q1**. Future = October onwards. Flag `expected_income_delayed` is cleared.

#### Delayed salary (`salary_delayed`)

On the first `asOf` where `asOf > expectedWindowEnd` and that cycle still has no `actualArrivalOn`:

- That cycle’s status becomes **`salary_delayed`**.
- `riskFlags` includes **`expected_income_delayed`**.
- Q1 must **not** keep excluding post-window Must Pay / Committed on the grounds that the missing salary would fund them.

Define:

```
delayedCycles     = funding cycles with asOf > expectedWindowEnd and actualArrivalOn is null
openWindowCycle   = cycle with expectedWindowStart <= asOf <= expectedWindowEnd
                    and actualArrivalOn is null
nextUnfailedCycle = earliest cycle with actualArrivalOn is null
                    and asOf <= expectedWindowEnd
                    // the still-open window if we are in one, else the next upcoming window
```

**Inclusion while `delayedCycles` is non-empty** — Must Pay / Committed, unpaid, **and** any of:

1. Assigned to the **active** cycle (last actual arrival); or
2. `dueOn <= asOf` (overdue); or
3. Due inside `openWindowCycle`’s window (D8, if a later window is already open); or
4. `dueOn <= nextUnfailedCycle.expectedWindowStart − 1 day`

Rule (4) is the conservative cover-through: the next *unfailed* window is the earliest date that might still bring income. Everything due before that must be evaluated against **current** available funds.

**Worked dates (window 4–8 Sep, card due 24 Sep, salary not received):**

| asOf | Sep status | `nextUnfailed` | Card 24 Sep in Q1? |
|---|---|---|---|
| 3 Sep | `upcoming` | Sep | No — due after window end; salary not yet delayed |
| 6 Sep | `window_open_unreceived` | Sep | No — due 24 Sep is after the 8th; D8 only includes dues on 4–8 |
| 10 Sep | `salary_delayed` | Oct (window 4–8 Oct) | **Yes** — 24 Sep ≤ 3 Oct; cannot stay excluded |
| 12 Sep, salary arrives | `active` | Oct | **Yes** — now an active-cycle bill; delayed flag clears |

Q2 must not credit `expectedAmount` for a `salary_delayed` cycle. Only cycles whose window has not failed may contribute expected income in projections.

If two cycles are delayed (Sep still missing on 10 Oct), `nextUnfailed` is November; cover-through is 3 Nov; the Oct 24 card then enters Q1 as well.

**Assignment** of an item to a funding cycle (for labels and Q2) is unchanged: expected salary may still *label* 24 Sep as September even before arrival.

```
assignFundingCycle(dueOn):
  the latest cycle whose reliableOrExpectedIncomeDate is on or before dueOn
  where reliableOrExpectedIncomeDate = actualArrivalOn ?? expectedWindowStart
```

Label ≠ Q1 inclusion. After delay, September-labelled bills are included even though they sit after the original 8th.

### 4.6 No double counting

For each included obligation:

```
unfunded = max(0, remainingToCounterparty - reservedLinkedToThisObligation)
```

Q1:

```
currentCycleSafeToSpend = availableLiquid - Σ unfunded(included)
```

Because `availableLiquid` already excluded reserved cash:

- If reserved 7,000 is for an **included** bill of 18,000, unfunded = 11,000. Effect: liquid − 7,000 − 11,000 = liquid − 18,000. Correct.
- If reserved 10,000 is for a **future** bill, unfunded of that bill is not in Q1. Effect: liquid − 10,000. Correct: you cannot spend the friend’s card money even though the bill is later.
- Never subtract `remainingToIssuer` **and** `reserved` for the same cycle.
- Never subtract total card outstanding across all cycles as a stock in addition to due items.

Total card outstanding belongs on Money, not in Q1.

### 4.7 F. Receivables

Listed as `unreceivedClaimsTotal` / explanation group **“Owed to you — not in this number.”**

Never added to Q1. “If they pay” is not a second hero. Affordability may show a **non-headline** sensitivity line only if we later approve it; V1 does not.

### 4.8 G–H. Planned, Flexible, investments, priority

| Priority | Coming up | Q1 | Q2 horizon |
|---|---|---|---|
| **Must Pay** | Yes | Subtract unfunded if included | Subtract in the cycle it is assigned to |
| **Committed** | Yes | Same as Must Pay | Same |
| **Planned** | Yes, labelled Planned | Do not subtract | Listed on horizon cycles; not in `blocked` arithmetic |
| **Flexible / Budget** | No | Ignore | Ignore |

An investment **transaction** that already happened reduced liquid via postings. A **future** SIP template at Planned does not hold cash.

If the user sets SIP priority to Committed or Must Pay, it behaves like rent for Q1.

### 4.9 Negative Safe to Spend

Do not clamp to zero. Negative means must-pays already exceed available liquid. Home shows it; risk flag `insufficient_for_must_pays`. If any cycle is `salary_delayed`, also set `expected_income_delayed`. There is no “previous month deficit” field — this **is** the shortage.

### 4.10 Explanation items (contract for the Explanation screen)

Ordered groups:

1. **In this number** — liquid, minus reserved (each reservation: account + obligation), minus each included unfunded line (uncertain flagged).
2. **Not in this number — later salary period** — excluded future must-pays/committed.
3. **Not in this number — not received** — open claims.
4. **Not in this number — planned / budgets** — SIP, category budgets.

Each line: `{ label, amount, sign, sourceRef, group }`. Sum of group 1 must equal `currentCycleSafeToSpend`.

### 4.11 Worked Q1 example (illustrative)

As of **20 Aug 2026**. August salary arrived 5 Aug. Next window 4–8 Sep, not arrived.

| | ₹ |
|---|---|
| HDFC balance | 50,000 |
| HDFC reserved (AXIS cycle due 24 Sep) | 10,000 |
| PNB + cash | 11,200 |
| liquidTotal | 61,200 |
| reservedTotal | 10,000 |
| availableLiquid | 51,200 |
| Rent due 18 Aug unpaid | 6,500 included |
| EMI due 20 Aug | 15,000 included |
| IDFC due 6 Sep | 3,100 included, uncertain |
| ICICI due 24 Sep remaining 18,400, reserved 0 | excluded (after window) |
| AXIS due 24 Sep remaining 10,000, reserved 10,000 | excluded; reserved already removed from available |
| included unfunded | 6,500+15,000+3,100 = 24,600 |
| **currentCycleSafeToSpend** | 51,200 − 24,600 = **26,600** |

AXIS reserved does not also subtract 10,000 as a bill in Q1. On 20 Aug the Sep window has not failed, so ICICI due 24 Sep stays excluded. After 8 Sep with salary still missing, that exclusion ends — Scenario O.

---

## 5. Affordability simulation model

### 5.1 Method

`simulateAffordability(asOf, proposal)` builds an **in-memory overlay**. No real events are written.

```
Proposal
  amount
  occurredOn            // usually asOf
  funding:
    accountId           // cash/bank spend
    OR creditCardId     // card spend
  categoryId            // optional, for consumption only
  meaning               // spend_account | spend_card
```

Steps:

1. Compute `baseline = evaluateSafeToSpend(asOf)`.
2. Apply hypothetical postings (same templates as §3.3).
3. If card: assign cycle from card rules; that may increase `expectedAmount` of a cycle, which may change `unfunded` in Q1 or only in a later funding cycle.
4. Compute `after = evaluateSafeToSpend(asOf)` on overlay.
5. Determine **horizon** (§5.1.1) and `projectFundingCycle` for each funding cycle from the immediate next through the horizon end.

Do not credit `expectedAmount` for a `salary_delayed` cycle.

#### 5.1.1 Projection horizon (minimum, deterministic)

Q2 does **not** always stop at the immediate next funding cycle. It also does **not** forecast unbounded months.

```
impactCycle =
  spend_account → none (cash leaves now; no new future obligation)
  spend_card    → assignFundingCycle(billingCycle.expectedDueDate)
                 // the cycle that must pay the new/increased card liability

horizonEnd = latest of:
  immediateNextFundingCycle     // next after active (may be salary_delayed)
  nextUnfailedCycle             // earliest window that has not failed; may equal immediate next
  impactCycle                   // if the proposal creates/increases a future obligation

horizon = every funding cycle C after the active cycle, through horizonEnd inclusive
```

A card spend after statement cutoff can have `impactCycle` two cycles out from active. Q2 must include that cycle. See Scenario P.

When a cycle is `salary_delayed`, it may still be in the horizon, but `expectedIncome = 0`. Income may only be credited on `nextUnfailedCycle` and later unfailed cycles.

Cap: V1 horizon is this computed range only. Do not walk an extra year “for safety.”

#### 5.1.2 Projecting one cycle

For each `C` in `horizon`, walking forward:

```
expectedIncome(C) = 0  if C.status would be salary_delayed at C.expectedWindowEnd
                    C.expectedAmount otherwise
                    // never added to Q1; only to that cycle’s projection

projectedAvailableAtCArrival =
    availableLiquid carried from previous step
  - unfunded must_pay/committed that Q1 would still include before C’s reliable-or-expected arrival
  + expectedIncome(C)

projectedSTS(C) =
    projectedAvailableAtCArrival
  - unfunded must_pay/committed assigned to C
    (including the hypothetical card increase if impactCycle = C)
```

```
worstProjectedSTS = min(after.currentCycleSafeToSpend, projectedSTS(C) for C in horizon)
worstCycleId      = the cycle (or current) that produced the min
```

Planned items are listed on those cycles, not subtracted, unless later approved otherwise.

### 5.2 Result API

```
AffordabilityResult
  proposal
  baseline: SafeToSpendSnapshot
  afterCurrent: SafeToSpendSnapshot
  currentCycleDelta
  currentBufferAfter           // after.currentCycleSafeToSpend  (may be negative)
  horizonCycleIds[]
  cycleProjections: CycleProjection[]   // one per horizon cycle, not only next
  worstProjectedSafeToSpend
  worstCycleId
  nextCycleProjection          // convenience: first horizon cycle (may equal worst)
  nextCycleBuffer
  conclusion: AffordabilityConclusion
  explanationItems[]
  consequencePreview
```

```
AffordabilityConclusion
  code: blocked | tight | comfortable
  currentFits: bool            // after.currentCycleSafeToSpend >= 0
  horizonHealthy: bool         // every projectedSTS(C) in horizon >= 0
  nextCycleHealthy: bool       // first horizon cycle; kept for copy; not the only test
  reasons[]
```

### 5.3 Conclusion rules (no AI, no magic rupee cushion)

| `code` | When |
|---|---|
| **blocked** | `after.currentCycleSafeToSpend < 0` **or** the paying account’s available (after overlay) would go negative **or** reserved funds would be consumed by a non-linked spend |
| **tight** | currentFits **and** (`currentBufferAfter == 0` **or** `horizonHealthy == false`) |
| **comfortable** | currentFits **and** currentBufferAfter > 0 **and** horizonHealthy |

The product-brief example (buffer ₹300, “technically yes but risky”) maps to **tight** when currentFits and the remaining buffer is small **or** any horizon cycle is unhealthy.

**V1 does not use a hidden ₹ threshold** (e.g. “tight if buffer < 5,000”). Zero remainder or any negative projected cycle STS is enough to be tight. A configurable `comfortFloor` may be added later (see §12 R1) without changing this default.

Copy is templated from `code` + `reasons[]`. Language models may later paraphrase `explanationItems`; they must not change `code`.

### 5.4 Card vs cash proposals

- **Cash/bank:** reduces available liquid now; Q1 drops by the amount (if it was available). Horizon is the immediate next funding cycle (no new future obligation).
- **Card:** liquid unchanged; the assigned billing cycle’s `expectedAmount` rises by the user’s share. Q1 drops **only if** that cycle is in the current inclusion set; otherwise the impact is on `impactCycle` inside the horizon. Consequence: “You can put this on the card; it becomes payable in [cycle].” If that is two cycles out, Q2 still evaluates it.

---

## 6. Card lifecycle model

```
CreditCard
  → BillingCycle (open)
      → spends (FinancialEvents + postings)
      → EventShares / Claims (others’ portions)
      → expected statement (date + derived amount)
      → actual statement (confirmed amount + date)
      → due date
      → collections (settlement_in + allocations + Reservations on bank accounts)
      → card payment (pay_obligation)
      → reservations consumed or released
      → surplus if reserved > remaining
      → status paid / closed
```

### 6.1 Cycle construction

Using the card’s effective-dated `statement_day` and `due_rule` at `occurredOn`:

Example: statement day 12, due 18 days later. Purchase **18 Aug** → window belonging to statement **12 Sep** → due **30 Sep**.

Purchase window: after previous statement date through this statement date (exact boundary: `(prevStatement, thisStatement]`). Snapshot the rule onto the cycle so later rule changes do not move historical spends.

### 6.2 Status

| Status | Meaning |
|---|---|
| `open` | Collecting spends; statement not yet due to generate |
| `statement_expected` | Expected statement date reached; amount still **Expected** |
| `statement_confirmed` | User entered actual statement amount/date |
| `due` | Due date reached, remaining > 0 |
| `paid` | remainingToIssuer = 0 |
| `closed` | paid **and** linked reservations consumed/released **and** no pending SurplusCase |

UI never presents expected amount as if it were a confirmed statement.

If `actualStatementAmount ≠ expectedAmount`, remaining uses **actual**. Difference explanation: “Statement is ₹X vs tracked spends ₹Y — fees, missing spends, or timing.” User may add missing spends or a **fee** event (card posting + expense or non-consumption fee classification — §12 R2).

### 6.3 Payment

`pay_obligation` with `creditCardId` and one or more `cycleAllocations` (user confirms if multiple open cycles).

Consumes reservations linked to those cycles on the **paying account** first.

See §8.3 if paying from a different account than the hold.

### 6.4 Default owner

On `spend_card` / `split`, owner defaults to `CreditCard.defaultOwnerPersonId` if set. Stored on the event as EventShares, not as a live lookup, so changing the card’s default owner later does not rewrite history.

### 6.5 Card EMI

No V1 UI. Cycle/spend records should allow a future `installmentPlanId` on an event without requiring it now. Do not model EMI as a second undocumented expense.

---

## 7. People / settlement model

### 7.1 Claim kinds

| Kind | Opens when | Collection default |
|---|---|---|
| `card_share` | Someone’s portion of a card event | Reservation toward that cycle, on the receiving **Account** |
| `shared_bill` | Someone’s portion of a bank/cash split | **Available** (cash already left). No reserve unless user links to another obligation |
| `direct_loan` | `lend` | Available. No reserve unless user links |
| `borrowing` | `borrow` | User owes them; `settlement_out` reduces it |
| `opening` | OpeningPosition | Same as a loan/bill as directed; reserve only if user later links |
| `surplus_payable` | Surplus resolution “I owe this back” | User owes person |

### 7.2 Net is derived

```
net(person) = Σ openAmount(they_owe_user) - Σ openAmount(user_owes_them)
```

Tests must mutate claims via events, then assert net — never write net directly.

### 7.3 Settlement in (someone paid me)

1. Amount, destination **Account**, date.
2. Engine **suggests** allocations (D4): card_share by earliest `expectedDueDate`, then other `they_owe_user` claims (shared_bill), then `direct_loan`. Preselect a single claim if the user opened Pay from that claim’s row.
3. User confirms. Mixed payments cannot skip this step.
4. Postings: +Account, −Claims.
5. For each allocation with `createsReservation` (card_share, or shared_bill that is still tied to an unpaid card cycle): create **Reservation** on that Account, linked to the cycle.
6. If confirmed allocations < amount: **SurplusCase** `unallocated_settlement` for the rest (not available).
7. If an allocation > claim.openAmount: apply openAmount; excess → **SurplusCase** `claim_overpayment`.

Consequence preview is mandatory.

### 7.4 Settlement out / reverse balance

`settlement_out` reduces `user_owes_them` claims. Does not create reservations. Cannot use reserved cash unless resolving a SurplusCase that belongs to that person (unusual).

### 7.5 Overpayment and reverse net

If they pay more than they owe and the user resolves surplus as `convert_to_payable`, open a `surplus_payable` claim (`user_owes_them`). Net can flip sign. That is valid.

---

## 8. Reservation lifecycle

### 8.1 Create

Only from confirmed allocations that are card-linked (and guarded corrections). Not from budgets. Not from “I might need this.”

Friend pays ₹10,000 into HDFC toward AXIS cycle:

```
HDFC balance +10,000
Claim −10,000
Reservation {
  sourceAccountId: HDFC
  remaining: 10,000
  obligationRef: AXIS billing cycle
  originatingClaimId: ...
}
HDFC available unchanged
```

### 8.2 Consume (pay linked obligation from the same account)

Pay AXIS ₹10,000 from HDFC:

```
HDFC −10,000 (drawn from reserved)
Card remaining −10,000
Reservation.consumed += 10,000
remaining 0, status consumed
```

If the payment is ₹8,000: consume 8,000, remaining 2,000 still held.

If the payment is ₹10,000 and reserved is ₹10,000, plus user owes more to issuer from their own funds: reserved consumed first, then available.

### 8.3 Release (purpose fulfilled from another account)

Reserved ₹10,000 in HDFC for AXIS. User pays AXIS ₹10,000 from **PNB**.

```
PNB available −10,000
Card remaining −10,000
Reservation on HDFC: released += 10,000
HDFC available +10,000   // same balance, hold removed
```

Explanation: “AXIS was paid from PNB, so ₹10,000 reserved in HDFC is now available.”

This is **not** surplus. The obligation absorbed a payment.

UI default: paying account = the account that holds reservations for this obligation.

### 8.4 Surplus (D10) — never auto-available

Triggers:

- Reserved remaining > remainingToIssuer after payment or after actual statement < reserved.
- Settlement amount not fully allocated.
- Allocation > claim open amount.

```
SurplusCase.kind = reservation_excess | unallocated_settlement | claim_overpayment
status = pending
cash remains unavailable
```

Plain-language explanation required, e.g. “Rahul sent ₹11,000 toward a ₹10,000 AXIS share. ₹1,000 is not applied.”

**Resolution (user must choose):**

| Code | Effect |
|---|---|
| `apply_to_other_claim` | Allocate to another open claim of that person; may create a new reservation if that claim is card-linked |
| `prepay_other_obligation` | Reassign reservation.remaining to another obligation the user names |
| `convert_to_payable` | Release hold into a `surplus_payable` claim (you owe them); cash becomes available **and** a payable exists — net worth unchanged; STS increases but Coming up / people show you owe them. This is explicit, not silent |
| `correct_allocation` | Reverse the original allocation (new reversing event) and re-run settlement confirm |
| `treat_as_mine_correction` | **Guarded.** Only if person link is missing or user asserts mis-tag. Requires confirmation copy: “This will treat ₹X as your money.” Audit trail |

There is no default “just keep it.” Closing a cycle with pending SurplusCase is **not allowed** (`closed` requires surplus resolved).

`convert_to_payable` increases STS because the cash is no longer purpose-bound **and** the user has acknowledged a debt. That is a real economic state, not a hidden gift.

### 8.5 History

Reservation mutations are implied by events (create/consume/release/reassign). Persist a small **ReservationLedger** (append-only: `{reservationId, eventId, deltaConsumed, deltaReleased, ...}`) so explanation can drill “why ₹10,000 reserved.”

---

## 9. Historical configuration strategy

### 9.1 Rule

**Events are facts. Config is a timeline of versions. Reports at date T use config as of T, and events that occurred on/before T.**

Changing a version with `effectiveFrom` in the future (or today forward) must not mutate events, postings, claims, cycles already closed, or past obligation instances.

### 9.2 What is effective-dated

| Setting | Mechanism |
|---|---|
| Salary amount, window days | IncomePolicy |
| Rent, insurance, SIP, family, EMI amount/due day | ObligationTemplate + ConfigVersion |
| Card statement day, due rule, default owner, limit | ConfigVersion on CreditCard; **new cycles** use new rules; existing cycles keep `ruleSnapshot` |
| Budget amounts | Budget keyed by calendar month |
| Category names | Current name for UI; optional `nameAsOf` if we need historical labels (V1.1). Amounts don’t depend on names |

### 9.3 Obligation instances

Generated with `amount` and `prioritySnapshot` copied from the template version effective on `dueOn`. Changing rent from 1 Jan next year leaves this year’s instances unchanged.

If the user edits a **single instance** (this month rent is different), that is an instance override, not a template rewrite.

### 9.4 Funding cycles already closed

IncomePolicy change effective Apr 2027 does not change FundingCycle 2026-08 expected/actual amounts.

### 9.5 Corrections vs config

Wrong recorded salary amount is an **event edit** (with warning), not a config change. Config never “fixes” a past posting.

---

## 10. Accounting invariants

These are test assertions. A failed invariant is a product bug, not a rounding footnote.

### 10.1 Classification

1. Internal transfer: source decrease = destination increase; net income = 0; net expense = 0. Signed postings are **not** required to sum to zero.
2. Card payment: Δexpense = 0, Δincome = 0; account decrease = card liability decrease.
3. Loan repayment received (`settlement_in` on `direct_loan`): Δincome = 0; account increase = claim decrease.
4. Other person’s card share: Δexpense = 0 for that share; card liability increase = claim increase.
5. User’s share of a split = expense; others’ shares ≠ expense; card (or bank) movement = expense + claims.
6. Investment contribution: Δexpense = 0; bank/cash decrease = investment account increase.
7. Refund of consumption: Δexpense ≤ 0 by refunded user share; never classified as income unless it is a true income event.
7a. Income event: account increase = income classification (both sides positive is valid).
7b. Every committed event satisfies its §3.3 conservation row.

### 10.2 Claims and settlements

8. A settlement posting that reduces claims must have SettlementAllocations summing to the reduced amount.
9. Claims cannot disappear except by allocations, reversals, or void-with-event.
10. `person.net` always equals the claim formula in §7.2.
11. Allocation amount cannot exceed claim.openAmount; excess becomes SurplusCase.

### 10.3 Reservations

12. For each Account: `sum(reservation.remaining) + pendingSurplus ≤ balance`. Else invalid.
13. Non-linked outflow from an account ≤ `available(account)`.
14. Reservations reference an existing obligation (cycle or instance).
15. Consuming a reservation requires a payment of that same obligation from that account.
16. Closing a BillingCycle requires `remainingToIssuer = 0`, all linked reservations consumed/released/reassigned, and no pending SurplusCase for those reservations.
17. Reserved remaining never auto-moves to available except via consume, purpose-complete release, or explicit SurplusCase resolution.

### 10.4 Periods and config

18. Changing config with `effectiveFrom >= today` (or a future date) does not modify FinancialEvents with `occurredOn < effectiveFrom`.
19. BillingCycle.ruleSnapshot is immutable after the first spend is attached (or after creation once spends exist).
20. Calendar month of consumption = month of `occurredOn`, independent of due date.
21. FundingCycle assignment of a card bill uses due date, not purchase date.

### 10.5 Safe to Spend

22. Unreceived claims are not added into `currentCycleSafeToSpend`.
23. Budgets are not subtracted.
24. For each included obligation, Q1 uses `unfunded`, never `gross + reserved`.
25. Q1 uses bank+cash only, not investments, not credit limit.
26. Items due inside the next salary window while salary is unreceived are included and flagged uncertain.
26a. After `expectedWindowEnd` with salary still missing, the cycle is `salary_delayed`; Must Pay / Committed due on or before `nextUnfailedCycle.expectedWindowStart − 1` are included; `expected_income_delayed` is set. Post-window bills must not stay excluded solely because they sat after the original 8th.
27. `sum(explanation group "in this number") = currentCycleSafeToSpend`.
27a. Signed postings on an event are not required to sum to zero.

### 10.6 Openings

28. OpeningPosition does not create merchants/activity rows in Activity (or they appear only as “Opening balance” / “Opening with Rahul”, never as spends).
29. Derived balances immediately after openings equal the opening payloads.

### 10.7 Simulation

30. `simulateAffordability` writes zero rows. Repeating it yields the same `conclusion.code`.
31. Q2 horizon is `max(immediate next, nextUnfailedCycle, proposal impactCycle)` and no further. `horizonHealthy` is false if any projected STS in that range is negative. Delayed cycles contribute `expectedIncome = 0`.

---

## 11. Scenario test matrix

Shared book where noted. **As of 1 Aug 2026 openings:** HDFC ₹50,000; PNB ₹8,000; Cash ₹2,000; no card outstanding; Rahul net 0; loan principal ₹2,40,000, EMI ₹15,000 due 20 Aug; IncomePolicy ₹79,200 window 4–8.

Consumption month = calendar month of `occurredOn`. Funding cycle for Q1 = as specified in §4.5.

---

### Scenario A — Salary + cash expense

**Events:** Salary ₹79,200 into HDFC on 5 Aug (`income`, starts FundingCycle 2026-08). Grocery ₹900 from HDFC on 10 Aug (`spend_account`, Grocery, GPay).

| | Effect |
|---|---|
| Accounts | HDFC +79,200 then −900 → **1,28,300** |
| Expense | +900 (August) |
| Income | +79,200 |
| Liability | 0 |
| Claims | 0 |
| Reservation | 0 |
| Reporting month | August |
| Funding cycle | 2026-08 active from 5 Aug |
| STS | Liquid up by 78,300 vs opening; Q1 then subtracts still-open must-pays (EMI 20 Aug, etc.) |

---

### Scenario B — Transfer between own accounts

**Events:** HDFC → PNB ₹5,000 on 11 Aug (`transfer`).

| | Effect |
|---|---|
| Accounts | HDFC −5,000; PNB +5,000; net liquid 0 |
| Expense / income | 0 |
| Liability / claims / reserved | 0 |
| Reporting | Not consumption |
| STS | Unchanged (unless HDFC-specific available was blocking — net available liquid unchanged) |

Invariant 1 holds.

---

### Scenario C — Personal credit-card purchase

**Events:** Fuel ₹2,400 on ICICI •8001 on 20 Aug. Statement day 12 → cycle statement 12 Sep, due 30 Sep. Sep salary window 4–8.

| | Effect |
|---|---|
| Accounts | 0 |
| Expense | +2,400 August |
| Card liability | +2,400 on Sep cycle |
| Claims | 0 |
| Reservation | 0 |
| Reporting month | **August** |
| Cash-flow / due | September |
| Funding cycle (bill) | **2026-09** |
| STS on 20 Aug | Q1 **unchanged** (due 30 Sep is after window end). Future obligations list +2,400. After Sep salary arrives, Q1 includes this cycle’s unfunded. |

---

### Scenario D — Shared credit-card purchase

**Events:** Restaurant ₹6,000 ICICI 16 Aug. You ₹2,000, Rahul ₹4,000.

| | Effect |
|---|---|
| Accounts | 0 |
| Expense | +2,000 August |
| Card | +6,000 |
| Rahul claim `card_share` | +4,000 |
| Reservation | 0 |
| Reporting month | August |
| Funding cycle (bill) | per due date of that cycle |
| STS | Same rule as C for the **unfunded** 6,000 if/when cycle is included; Rahul’s 4,000 does **not** reduce Q1 (unreceived). |

Identity: 6,000 = 2,000 + 4,000.

---

### Scenario E — Friend pays full card share early

**Events:** After D, Rahul pays ₹4,000 into HDFC on 18 Aug. User confirms 100% to the card_share (preselected from that claim).

| | Effect |
|---|---|
| Accounts | HDFC +4,000 |
| Expense / income | 0 |
| Card | unchanged (still owe issuer 6,000) |
| Claim | −4,000 (settled) |
| Reservation | HDFC +4,000 → that ICICI cycle |
| STS | availableLiquid unchanged. If cycle is **future**, Q1 unchanged. If cycle is **included**, unfunded drops 4,000 and reserved rose 4,000, Q1 **+4,000**. |

---

### Scenario F — Partial card share

Same as E with ₹2,500 of ₹4,000. Claim open ₹1,500. Reservation ₹2,500. Same STS pattern on the ₹2,500 slice.

---

### Scenario G — Friend overpays card share

**Events:** Rahul owed ₹10,000 card_share. Pays ₹11,000 into HDFC. User allocates ₹10,000 to the claim (max). ₹1,000 not allocated.

| | Effect |
|---|---|
| Accounts | HDFC +11,000 |
| Income | 0 |
| Claim | −10,000 (settled) |
| Reservation | +10,000 to the cycle |
| SurplusCase | ₹1,000 `unallocated_settlement` or `claim_overpayment`, pending, **not available** |
| STS | availableLiquid +0 from the ₹10,000 slice; the extra ₹1,000 is not in available. Q1 does not treat ₹1,000 as spendable. |

User must resolve surplus (§8.4). Cycle cannot close while this is pending if it is reservation_excess on that cycle; unallocated cash surplus is independent and still blocks treating that rupee as available.

---

### Scenario H — Direct loan ₹10,000 then ₹4,000 repayment

**Events:** Lend from HDFC 2 Aug. Rahul pays ₹4,000 to HDFC 12 Aug, allocated to `direct_loan`.

| | After lend | After repay |
|---|---|---|
| HDFC | −10,000 | +4,000 (net −6,000) |
| Expense / income | 0 | 0 |
| Claim | +10,000 | +6,000 open |
| Reservation | 0 | 0 |
| STS | −10,000 | +4,000 (available) |

---

### Scenario I — Mixed ₹12,000 settlement

Rahul open: card_share ₹7,000, dinner-on-card ₹2,000, direct_loan ₹10,000. Pays ₹12,000 HDFC. **Suggested** 7k / 2k / 3k; **user confirms**.

| | Effect |
|---|---|
| HDFC | +12,000 |
| Income | 0 |
| Claims | card 0, dinner 0, loan open ₹7,000 |
| Reservation | +9,000 toward card cycle(s) |
| Available | +3,000 |
| STS | +3,000 immediately; plus the §E effect on unfunded if those cycles are in Q1 |

---

### Scenario J — Aug spend, Sep statement, due after Sep salary

**Events:** Personal purchase 28 Aug ₹5,000 ICICI. Statement 5 Sep, due 24 Sep. Window 4–8 Sep.

| Date | Q1 treatment of this ₹5,000 |
|---|---|
| 28–31 Aug | Excluded (due after window). Spending analytics: **August** |
| 1–(salary) Sep | Still excluded if due 24 Sep > 8 Sep; salary not used as if arrived |
| After Sep salary arrives | **Included** in active cycle 2026-09 |

Funding cycle label is September throughout. Cash-flow month September. Never collapse to one month.

---

### Scenario K — Card due inside salary window, salary not arrived

**Events:** IDFC remaining ₹3,100 due **6 Sep**. Today **5 Sep**. Window 4–8. No salary event.

| | Effect |
|---|---|
| Include in Q1 | **Yes**, `uncertainWindow = true` |
| Flag | “Due during salary-arrival window — current funds may be needed.” |
| After salary event on 5 Sep | Item stays in Q1 as a normal active-cycle must-pay (no longer uncertain) |

Engine must not assume salary on 4 Sep paid this bill.

---

### Scenario L — Month changes, receivable and reservation remain

**State on 31 Aug:** Rahul claim ₹4,000; HDFC reserved ₹4,000 for Sep ICICI cycle.

**On 1 Sep:** No generated reversal. Balances, claims, reservations identical. August budgets reset (V1). August “You spent” frozen from August events. Q1 recomputes with new `asOf` (Sep 6 uncertain item may newly enter).

No “previous month deficit” field.

---

### Scenario M — Salary changes next year

**Config:** IncomePolicy ₹79,200 through 2027-03-31. New policy ₹85,000 from 2027-04-01.

| | Effect |
|---|---|
| Events in 2026 | Unchanged |
| FundingCycle 2026-08 expected snapshot | 79,200 |
| Q1 expected next income in Mar 2027 | 79,200 |
| Q1 expected next income in Apr 2027 | 85,000 |
| Activity / month reports 2026 | Unchanged |

---

### Scenario N — Can I spend ₹15,000? Cash fits; next cycle does not

**Illustrative as-of 25 Aug 2026** (August salary already arrived; no remaining included must-pays).

| | ₹ |
|---|---|
| availableLiquid | 31,000 |
| included unfunded | 0 |
| Q1 currentCycleSafeToSpend | 31,000 |
| Proposal | ₹15,000 from HDFC `spend_account` |
| after Q1 | 16,000 — **currentFits** |
| Next salary expected | 79,200 on window 4–8 Sep |
| Next-cycle must-pay/committed unfunded | 98,000 |
| projectedAvailableAtNextArrival | 16,000 + 79,200 = 95,200 |
| projectedNextCycleSTS | 95,200 − 98,000 = **−2,800** |
| nextCycleHealthy | false |
| **conclusion.code** | **tight** |

Narrative (templated): “You can pay for this from current funds (₹16,000 would remain before salary). After expected September salary, must-pays would exceed available by ₹2,800. Not comfortable.”

Future card dues included in the ₹98,000 are listed in explanation; they are not also subtracted from the ₹31,000 Q1 headline.

If the same ₹15,000 were put on a card whose due is 24 Sep, Q1 might stay 31,000 (due after window, and window not yet failed) while September-horizon unfunded rises by 15,000 — still Q2 **tight** or worse. If cutoff pushes the due into October, Scenario P applies: horizon must include October.

---

### Scenario O — Salary window passed, salary still missing

Window 4–8 Sep. Card ICICI remaining ₹8,000 due **24 Sep**. `availableLiquid` ₹20,000. No other unpaid Must Pay / Committed. August salary already arrived. September salary event does not exist until 12 Sep.

| asOf | Sep cycle status | 24 Sep card in Q1? | Q1 | Flags |
|---|---|---|---|---|
| 3 Sep | `upcoming` | No (due after window end) | ₹20,000 | none |
| 6 Sep | `window_open_unreceived` | No (D8 covers only dues on 4–8 Sep) | ₹20,000 | none for this card; any 4–8 due would be `uncertainWindow` |
| 10 Sep | `salary_delayed` | **Yes** — 24 Sep ≤ 3 Oct (`nextUnfailed` = Oct) | ₹12,000 | `expected_income_delayed` |
| 12 Sep, salary ₹79,200 arrives | `active` | **Yes** (active-cycle bill) | ₹91,200 | delayed flag cleared |

On 10 Sep the card must not remain excluded merely because 24 Sep is after the original 8th. Q2 on 10 Sep must not add ₹79,200 expected September salary (`expectedIncome` of a delayed cycle = 0).

---

### Scenario P — Card purchase lands two funding cycles later

**As of 28 Aug 2026.** August salary has arrived. Next funding cycle = September (4–8 Sep).

Card statement day **25**. Purchase **28 Aug** is after the 25 Aug cutoff → statement **25 Sep**, due **13 Oct** (18 days). Due 13 Oct assigns to **October** (`impactCycle` = October). Immediate next = September. **Horizon = September and October.** Stopping at September would miss the bill.

Illustrative overlay (personal card spend ₹20,000; Q1 has no remaining included bills):

| | Without proposal (₹) | With ₹20,000 card (₹) |
|---|---|---|
| Q1 current STS | 50,000 | 50,000 (Oct due; window not failed) |
| Sep projected STS | 50,000 + 79,200 − 70,000 = **59,200** | **59,200** (this card not due in Sep) |
| Oct projected STS | 59,200 + 79,200 − 1,20,000 = **18,400** | 18,400 − 20,000 = **−1,600** |

| Result | |
|---|---|
| currentFits | true |
| horizon | 2026-09, 2026-10 |
| worstCycleId | 2026-10 |
| worstProjectedSTS | −1,600 |
| horizonHealthy | false |
| **conclusion.code** | **tight** |

A Q2 that only projected September would have returned `comfortable` (59,200) and would be wrong.

---

## 12. Remaining product decisions / risks

None of these block documenting the engine; several block locking tests or UI copy.

| ID | Topic | Risk | Recommendation |
|---|---|---|---|
| **R1** | Comfort floor for `tight` vs `comfortable` | ₹300 buffer in the original story vs zero-based rule in §5.3 | Ship §5.3 (no magic threshold). Optional user `comfortFloor` later. |
| **R2** | Statement ≠ tracked spends (fees, interest, missing) | Cycle remaining would be wrong | V1: confirm actual statement; difference line; user adds fee/missing spend. Do not silently force-fit. |
| **R3** | EMI interest vs principal | D6 excludes “loan principal transfers where appropriate” | V1: EMI payment is **not** “You spent” unless user enters an interest split. Whole EMI is must-pay cash-flow. Interest field optional. |
| **R4** | Paying one card from multiple accounts in one event | Complexity | V1: one paying account per payment event; multiple events allowed. |
| **R5** | `convert_to_payable` increases STS | Feels like “keeping their money” | Keep it — it is honest if we also show “You owe Rahul ₹1,000.” Confirm copy must say both. |
| **R6** | Expected extra income (Apr/Sep) | Users may want it in Q2 | V1: not reliable income; list in explanation only. |
| **R7** | Committed vs Must Pay in Q1 | Both subtract today | Keep both subtracting; distinguish only in Coming up labels and default templates. |
| **R8** | Timezone / “today” | Cycle and window boundaries | Asia/Kolkata calendar dates. `occurredOn` is a date, not an instant. |
| **R9** | Multiple open cycles payment allocation | Ambiguous like D4 | Suggest earliest due; user confirms. |
| **R10** | Investment as liquid | Tempting to count MF | Never in Q1. |
| **R11** | Card credit limit as spendable | Common tracker mistake | Never in Q1. |
| **R12** | Concurrent edits / double capture | Duplicate spends | V1 single user; still idempotency keys later for imports. |
| **R13** | Negative account available from bug | STS lies | Invalid state banner; block new outflows until repaired. |
| **R14** | Opening card: outstanding vs statement vs unbilled inconsistency | User may enter numbers that don’t add | Require outstanding ≥ 0; if all three provided, assert outstanding ≈ statement + unbilled or ask which to trust. |

---

## 13. Approval checkpoint

Please approve or amend:

1. Event = header + **postings** + **holds** (reservations are not GL accounts).
2. Person net **derived from Claims**; openings are **OpeningPositions**, not fake spends.
3. Reservations **account-scoped and obligation-linked**; surplus **never auto-available**.
4. Q1 formula: `availableLiquid − Σ unfunded(included must_pay/committed)` with D8 uncertain-window inclusion **and** delayed-salary cover-through (§4.5).
5. Q2 overlay simulation; horizon = max(next cycle, proposal impact cycle); `blocked | tight | comfortable` without a hidden rupee cushion.
6. Scenario matrix A–P as the acceptance tests for Stage 5+.

No database schema, framework, or UI implementation until this stage is approved.
