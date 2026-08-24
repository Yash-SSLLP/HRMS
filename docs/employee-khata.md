# Employee Khata — one advance wallet per person, and the books they spend it under

Khatabook-style cash accounting between the company and each member of staff.
The company advances money into an employee's **wallet**; the employee then
records what they spent it on against whichever **khata** (expense book) the
spend belongs to. What is left over is one figure, and it reads the same
whichever book you have open.

**One wallet. Many khatas.** A site supervisor holds one advance and files their
purchases under "Site A — materials", "Vehicle & fuel", "Client hospitality".
The books say what the money went *on*; the wallet says how much is *left*.

It sits **on top of** the existing cashbook rather than replacing it. The
cashbook answers *"how much is in the tin?"*. The wallet answers *"how much is
Rahul holding right now?"* — a question the cashbook could never answer, because
there a payout is just a flat line with a party name on it. The khatas answer
*"and what did he spend it on?"*.

> **Why it works this way.** Advances used to be given to a *specific khata*, so
> an employee with three books had three separate pots and had to ask for money
> against the right one — and could be flush on one while unable to spend on
> another. That is not how carrying cash works: notes in a pocket are fungible,
> and only the *reason* they were spent needs separating. So the balance moved
> to the wallet and the khata kept the categorisation, which was the genuinely
> useful half. See **Migration** below.

---

## The one rule everything rests on

The wallet balance is held from the **company's** point of view, and the
direction of the money is the only thing that sets the sign:

| Direction | Meaning | Effect | Company sees | Employee sees |
|---|---|---|---|---|
| `to_employee` | company → employee | `wallet += amount` | **You will get** | Advance in hand |
| `from_employee` | employee → company | `wallet -= amount` | **You will give** | (reduces what they hold) |

A negative wallet means the employee spent past their advance, so the company
owes them the difference.

`type` (`advance`, `settlement`, `expense`, `reimbursement`, `salary_recovery`,
`opening`, `reversal`, `other`) is a reporting label and never changes the
arithmetic — but it *does* decide which book a row is filed under:

| `type` | `khata` | Because |
|---|---|---|
| `expense` | **required** | Spending is the thing that needs a heading. |
| everything else | `null` | An advance, a return, a reimbursement or a payroll recovery moves the pot itself and belongs to no one book. |

`KhataEntry.balanceAfter` is therefore always the **wallet** balance after that
row, even on a row filed under a khata — the wallet is the only thing that has a
balance.

The words "debit" and "credit" appear nowhere in the UI. Both apps take their
wording from the server (`describeBalance` / `describeWalletForEmployee`) so
they cannot drift apart on the most confusable thing in the module.

## Four guarantees

1. **The balance cannot drift.** It is never incremented in place. After any
   change the employee's whole ledger is replayed from the opening balance
   (`replayBalance` → `recomputeWalletBalance`), so a back-dated entry also
   re-stamps every later running balance.
2. **The books add up to the pot.** A khata's `spent` is replayed from the same
   rows (`recomputeKhataSpent`), so "what is left" and "what it went on" can
   never tell two different stories. Both are driven from one call,
   `recomputeFor(entry)`, so a new posting path cannot update one and forget the
   other.
3. **Company cash and the employee ledger move together.** An advance leaving
   the petty-cash tin also posts a `CashbookEntry`, cross-linked both ways
   (`KhataEntry.cashbookEntry` ↔ `CashbookEntry.sourceKhataEntry`).
4. **Posted money is never deleted.** A correction is a *reversal*: the original
   is marked `Reversed` and a mirror row is written against it, on both books.
   The ledger reads `₹5,000 out, ₹5,000 back, ₹4,500 out` — never a row that
   silently changed. A reversal is filed under whatever it cancels, so undoing
   an expense also takes the cost back off the book it was charged to.

---

## Recording an expense — approved by default, rejected on review

An expense **posts on the spot**. The purchase already happened, at the shop,
with money the employee was already holding; queueing the record changed nothing
except to make the wallet lie about what was left in their pocket until somebody
got round to it. So the entry counts immediately and the company reviews it
afterwards.

**The bill is therefore mandatory.** It is the only control left once the
approval step is gone — nothing else stands between "I spent ₹5,000" and the
wallet dropping by ₹5,000. `POST /me/expense` refuses without a file, checked
*before* the entry posts, so a missing bill can never leave a posted row with no
evidence behind it. Both clients block it too, so the failure is immediate
rather than a round trip.

**Rejecting is a reversal**, not a status change — posted money is never
deleted. The mirror row puts the amount back on the employee's advance, takes
the cost back off the book it was charged to, and both rows stay on the record.
The employee is told it was *rejected* rather than *reversed*, because from
their side nobody ever approved it.

Any khata operator may reject one, not just a SuperAdmin. An expense
self-approves, so this reversal **is** the company's review of it; reserving it
for a SuperAdmin would leave the accounts team watching wrong entries they could
not correct. Safe because no company cash moves either way — it only restores
the employee's wallet.

Find them under **Admin → Employee Khata → Approvals → Expenses to confirm**
(they never reach `/pending`, having never been pending). Rows with no bill are
flagged there, since that should not be possible through either client.

## Confirming an expense — and the editing window before it

Posting on the spot puts a figure on the ledger before anybody has checked it.
That is worth it (see above), but it cuts both ways: a digit fat-fingered at a
shop counter is now a wrong number in the accounts. Requiring a *reversal* to fix
a typo would make the ledger read like a fraud being unwound every time somebody
mistyped ₹550 as ₹5,500.

So an expense stays **editable until the company confirms it**:

| | While unconfirmed | After confirming |
|---|---|---|
| The employee who filed it | may correct amount, purpose, book, date, payment mode, bill — **unless the book has been closed** | no |
| The company (`khata.manage`) | may correct any of it, closed book or not | no |
| Either | — | reverse it and re-enter |

**It counts the whole time, at whatever it currently says.** An edit is a
correction to a live figure, not a new request waiting to take effect: change the
amount and the wallet moves with it, immediately. This is the point the wording
on both clients makes, because the alternative reading — "my edit is pending" —
would have people spending money they had already spent.

`PATCH /entries/:id/confirm` is what closes it. It moves no money at all; what it
changes is who may still touch the row (nobody). Its counterpart is rejecting,
which is a reversal. Both take the row out of the review queue, which is why the
queue asks for `confirmed=false`.

**Nothing is edited silently.** `KhataEntry.edits[]` keeps every correction —
when, by whom, employee or company, and a readable summary of what changed
(`amount: ₹500 → ₹550; what for: "cement" → "sand"`). The review queue shows the
latest one against the row, so nobody confirms a figure without knowing it is not
the figure that was first filed. Both books are replayed when a correction moves
spending between them, so the cost comes off the old heading as well as landing
on the new one.

An expense can never be moved *into* a closed book, by either side — otherwise
closing one would not stop it growing.

## Where an expense was filed from

Filing an expense captures the device's location and stores it on the entry
(`KhataEntry.filedLocation` — lat, lng, the device's own accuracy estimate in
metres, and when). It is not where the money was spent, which nobody can know;
it is where the person stood when they told us about it. On a module whose only
control is "the employee records their own spending honestly, with a bill", that
context is worth having: an expense filed from the site it belongs to reads
differently from one filed three states away.

**Super Admins only.** `publicEntry` takes the viewer it is building the payload
for and includes the location only for a SuperAdmin — not the accounts team, not
the employee's manager, not the employee themselves. Passing no viewer means
"show nobody", so a call site that has not thought about it leaks nothing by
omission. The same rule guards expense *claims*, from the other direction:
`Expense`'s `toJSON` deletes the field on the way out and the admin list puts it
back for a SuperAdmin, so the default everywhere is "not exposed".

Because the clients are only ever *sent* a location when the viewer may see it,
neither app carries a role check for this — the absence of the data is the
permission check, and there is no second copy of the rule to fall out of step.

**Best-effort, never blocking.** A refused permission, a phone indoors with no
fix, a browser that denies it — all leave the field null and the expense is
filed regardless. Refusing to record money somebody has already spent because
the satellites were unhelpful would be absurd, and an absent location is more
honest than a fabricated one. The accuracy figure travels with the reading
because a ±2 km fix and a ±8 m fix are not the same evidence.

Both apps say so on the form, in plain words, before the employee submits.
Captured on FILING only — a later correction does not overwrite it, since the
question it answers is where the expense was originally declared.

## Closing a khata is the company's act

Only `khata.manage` can close a book (`PUT /khatas/:khataId`, `isActive:false`).
There is no self-service equivalent anywhere in the API or either client, and
that is deliberate: closing is finance saying *"this job is done and its figures
are ours now"*.

Closing does three things:

1. the book takes no new entries (`resolveKhata` refuses it);
2. it drops out of the pickers;
3. **the employee can no longer edit the expenses already in it** — while the
   company still can. Leaving the employee able to reach back into a closed book
   would make the closure meaningless; sealing it against its own owner as well
   would leave finance unable to fix what they find in there.

The employee is notified when a book is closed or re-opened, because closing
takes two things away from them at once and neither should have to be discovered
by trying.

The **default** book cannot be closed — self-service would have nowhere to file
an expense. Promote another book first.

## When the wallet goes negative

Spending past the advance flips the wallet negative: the company now owes the
employee. Every other self-service action moves money *towards* the company, so
without one more the employee would have no way to ask for it back.

`POST /me/reimbursement` is that action — **"Ask to be paid back"**, offered on
the wallet card only when there is something to claim, and pre-filled with the
whole outstanding amount. It parks as `Pending` for the accounts team, who pick
the account it is paid from; approving posts the cash leg and lifts the wallet
back towards zero.

Deliberately **not** behind the CEO/MD gate. That gate asks "should this person
be given company money?", which is not the question here: this money has already
been spent on the company's behalf, and each expense behind it was confirmed one
at a time.

`GET /me` returns `totals.claimable` = what the wallet has gone negative by,
**less anything already claimed and unpaid**. That subtraction is the guard: a
second claim submitted before the accounts team has settled the first would
otherwise ask to be paid the same debt twice, and both would look legitimate
side by side in the queue.

## The life of an advance — two gates, two different questions

```
employee asks  →  AwaitingApproval  →  Pending  →  Approved
                  "should they         "which      cash moves,
                   have it?"            account?"   wallet rises
                  CEO / MD             accounts team
```

**Gate A — should they have it?** `POST /me/request` parks the request as
`AwaitingApproval`, and only a **SuperAdmin, CEO or MD** can decide it
(`requireAdvanceApprover`). Approving moves **no money**: it drops the request
into the accounts team's queue. Declining closes it, with a reason the employee
sees.

A SuperAdmin can switch this gate off org-wide — **Permissions → CEO / MD
approval for cash advances**. With it off, requests park as `Pending` and go
straight to the accounts team, exactly as they used to.

> The requirement is read when a request is **raised** and stamped onto the row
> (`KhataEntry.execApprovalRequired`). Turning the gate off later therefore does
> not strand requests already sitting with an executive, and turning it on does
> not retroactively invalidate ones raised while it was off.

**Gate B — where does the cash come from?** An operator picks the cash account
and approves; only then does money leave the tin and the wallet rise. This is
the pre-existing operator/threshold machinery, unchanged.

The two queues are deliberately separate endpoints with separate audiences.
`GET /pending` never shows an executive's queue to an operator who cannot act on
it, and `GET /advance-approvals` needs no `khata.manage` — which is what lets a
read-only CEO/MD account act there and nowhere else.

**Sanctioning is the one write a read-only executive may make here.** Everywhere
else a CEO/MD is view-only unless a SuperAdmin has switched them into edit mode;
this decision is the reason the approval step exists, so gating it behind a
second unrelated grant would mean the person the request is addressed to could
not answer it.

---

## Who can move money — four gates, deliberately separate

Holding the capability opens the module. It pays nobody on its own.

**Gate 1 — `khata.manage`** opens the khata screens. Granted by: SuperAdmin
(implicitly), AccountsManager (by role), an HR Manager or Manager holding the
capability, or **anyone at all** via the standalone `User.khataAccess` flag — so
the branch supervisor who actually hands out cash needs no admin role.

**Gate 2 — SuperAdmin / CEO / MD** sanction advance requests. See above.

**Gate 3 — `CashAccount.operators`** decides whose money you may touch. Each
account carries a list of operators, each with:

| Field | Meaning |
|---|---|
| `canDisburse` | May release cash at all. `false` ⇒ every entry they raise parks for approval, whatever the amount. |
| `maxPerTransaction` | **Auto-approve threshold, not a hard ceiling.** At or below it, the money moves at once. Above it the entry is still accepted but parks as `Pending`. `0` = no threshold. |
| `canApprove` | May release *other people's* parked entries on this account. Off by default — recording a payout and releasing one are different grants. |

A SuperAdmin is implicitly an operator on every account with no threshold, which
is what makes a newly created account usable before anyone is listed on it.

So: *Amit can pay ₹5,000 out of Petty Cash directly, anything larger goes for
approval, and he cannot touch the Main Bank account at all.*

Managed at **Admin → Employee Khata → Accounts** (SuperAdmin only).

**Gate 4 — `User.khataExportAccess`** decides who may *download* the khata. The
**Export to Excel** buttons (Overview and Ledger tabs) and
`GET /reports/export` need it on top of Gate 1. **No role confers it** — not
Accounts Manager, not an HR Manager with every capability. Only a SuperAdmin
grants it, per person, on the **Permissions** page, and it can be given to
anyone at all.

Its own gate because reading balances on screen and carrying every employee's
borrowing history out in a file that can be mailed on are different decisions.
Routing it through `hasPermission` would have got it wrong: an HR Manager whose
`permissions` array was never configured holds *everything* by default, so the
grant would have landed on people nobody consciously chose. `canExportKhata` in
`backend/middleware/authMiddleware.js` therefore answers on role and flag alone,
with no capability fallback — and, unlike the capability guards, gives a CEO/MD
no free pass on the GET either.

---

## Expense books

| Rule | Why |
|---|---|
| Names are unique per employee | "Site A" must mean one thing for one person. A duplicate is rejected, not silently created alongside. |
| Exactly one `isDefault` book | Where an expense lands when no book is named. Opened lazily as **"General"** on first use, so an employee can file a purchase before anyone has organised anything. |
| A book **with spend on it can** be closed | `spent` is history, not an outstanding amount, and the money itself is on the wallet where closing a folder cannot hide it. (This is the opposite of the old rule, and the reason the old rule existed is gone.) |
| The default book cannot be closed | Self-service would have nowhere to file an expense. Promote another book first. |
| An entry naming another employee's book is refused | Without this check, a request carrying somebody else's khata id would file one person's spending under another person's book. |

`spent` is a running **total**, not a balance: what this heading has cost. It is
a cache, replayed from the ledger, and it goes down only when a row filed under
it is reversed.

`recomputeKhataSpent` filters on **type**, counting only spending and the
reversals that cancel it, rather than summing everything in the book. A book can
still contain rows that do not belong to it — a database migrated from the
per-khata era has advances and settlements filed under one, and the module has
to read correctly before anybody runs the migration. An advance counted there
comes out *negative* under the sign flip and prints as "-₹4,500 spent", which is
not a thing that can happen to a cost.

**Both sides can open a book.** A khata operator opens one for anybody
(`POST /khatas`); an employee opens one on their own account
(`POST /me/khatas`, capped at 25). Deciding that spending needs its own heading
is part of doing the job, and a book holds no money — so it needs no approval and
carries no limit of its own.

### Totals are never netted across people

`splitTotals` returns `{ get, give, net }` over a set of wallets and the screens
show `get` and `give` side by side. One person holding ₹5,000 of our cash while
the company owes somebody else ₹2,000 is two separate facts; collapsing that to
"₹3,000 receivable" is how a company forgets to pay somebody back.

## Guard rails

- **Advance limit** (`EmployeeWallet.creditLimit`, `0` = none) — an advance that
  would take that *person* past it is refused. Per person rather than per book,
  because the pot is the person's: a per-book limit could be walked around
  simply by opening another book. Re-checked at approval time, not trusted from
  submission, because a request can sit in the queue while other entries move
  the balance. Settlements and expenses are **never** blocked: nobody should be
  stopped from accounting for money they already hold.
- **Idempotency** — `KhataEntry.idempotencyKey` means a double tap or a mobile
  retry over a flaky link returns the original row instead of paying twice.
- **Opening balance** is SuperAdmin-only. It is the one figure that moves a
  balance with no ledger row behind it.
- **Employees never self-release.** `POST /khata/me/request`, `/me/reimbursement`
  and `/me/settle` always park, whatever permissions the caller holds. `/me/expense`
  is the deliberate exception — it accounts for money already spent rather than
  asking for any, so it posts at once and is rejected on review instead. Its
  mandatory bill is what replaces the approval.

---

## API

Mounted at `/api/khata`. All routes authenticated.

**Employee self-service** — any user, own wallet only

| Route | Purpose |
|---|---|
| `GET /me` | My wallet, my books (each with its `spent`), the totals (including `claimable`), one statement, and whether a request will need a CEO/MD sanction |
| `POST /me/request` | Ask for an advance into my wallet — no `khata`, there is one pot |
| `POST /me/expense` | Log what I spent it on — `khata` **required**, receipt **required**. Posts immediately |
| `PUT /me/expenses/:id` | Correct one of mine the company has not confirmed yet — amount, purpose, book, date, mode, and optionally a replacement bill. Refused once it is confirmed or its book is closed |
| `POST /me/settle` | Declare unspent cash returned — no `khata`, optional receipt |
| `POST /me/reimbursement` | Claim back what the company owes, when the wallet has gone negative. Amount defaults to everything outstanding and is capped at `totals.claimable` |
| `POST /me/khatas` | Open an expense book on my own account |
| `GET /me/statement.pdf` | My khata as a printable statement, bills bound in (`?khata=` narrows it). The employee id comes from the token, never the URL |

**Advance sanction** — SuperAdmin / CEO / MD only, **no** `khata.manage` needed

| Route | Purpose |
|---|---|
| `GET /advance-approvals` | Requests awaiting a decision, each with what the asker is already holding |
| `PATCH /entries/:id/exec-decision` | `{ approve, note }` — moves no money either way |

**Operators** — all require `khata.manage`

| Route | Purpose |
|---|---|
| `GET /overview` | Receivable / payable totals, **both** queue counts, my accounts |
| `GET /accounts` | Accounts I may pay from, with my limits |
| `GET /employee-options` | Thin employee picker (no salary or personal data) |
| `GET /employees` | One row per person — their wallet plus their books |
| `GET /employees/:id` | One person's wallet, books and statement (`?khata=` narrows it) |
| `GET /employees/:id/statement.pdf` | The same book as a **printable statement PDF** with every photo bill embedded — `?khata=`, `?from=`, `?to=`. **Not** behind `khataExportAccess`: that gate is about walking out with the whole ledger as data, this is one person's book laid out to be read |
| `PUT /wallets/:employeeId` | Advance limit and note (opening balance ⇒ SuperAdmin) |
| `POST /khatas` | Open a new named expense book for someone |
| `PUT /khatas/:khataId` | Rename, note, make default, close / re-open |
| `POST /entries` | Give an advance, record cash back, or file an expense (`type: 'expense'` ⇒ `khata` required) |
| `GET /entries` · `GET /pending` | Ledger · the accounts team's queue. `?confirmed=false` on `/entries` is the expenses-to-confirm queue |
| `PATCH /entries/:id/approve` · `/reject` | Release · decline (approve needs `canApprove`) |
| `PUT /entries/:id` | Correct an unconfirmed expense on the employee's behalf — including one in a closed book, which the employee can no longer touch |
| `PATCH /entries/:id/confirm` | Accept a posted expense. Moves no money; **locks** the row against further edits on both sides |
| `POST /entries/:id/reverse` | Cancel with a mirror row; reason required. Also how an employee expense is **rejected** — any `khata.manage` holder may do it for a cashless expense, SuperAdmin/`canApprove` otherwise |
| `GET /reports/outstanding` | Who is holding cash, with ageing bands and what they have been spending on |
| `GET /reports/export` | Wallets + books + full ledger as `.xlsx` — **also needs `khataExportAccess`** (Gate 4) |
| `POST /reports/remind` | Nudge everyone holding company cash |

**SuperAdmin only**: `GET|PUT /accounts/:id/operators`,
`POST /wallets/:employeeId/recompute` (repair tool — rebuild one person's books
and wallet from the ledger, for use after a direct database edit or a restored
backup).

---

## The statement PDF

`services/cashbookSummaryPdf.js`. The `.xlsx` export answers *"give me the
data"*; this answers *"show this to the person who paid for it"* — a
day-by-day statement with **every photo bill bound in behind it**, so the
document still works once it has been emailed, printed, or opened next year.

Reachable from the web and the mobile app alike, all producing the same
document:

* **Admin → Khata → People → someone** — *Statement PDF* on the person (every
  book, or whichever one is currently being viewed), or on any khata card. A
  small dialog asks for an optional date range first.
* **My Khata → Statement → Download PDF** — an employee's own books, no extra
  permission. The employee id comes from the token, so there is nothing in the
  URL to tamper with.
* **Mobile, same two places** — the *Statement PDF* button on a person and on
  each khata card in the admin screen, and the *PDF* action on the Statement
  header in My Khata. The file goes straight to the OS share sheet, so it can be
  WhatsApped or emailed from the site without a laptop.

### Two scopes, one renderer, and why the arithmetic differs

`?khata=` set prints **one expense book**; omitted, it prints the person's
**whole wallet**. IN is *always* money that reached the employee. What changes
is only what the running total means:

| Scope | Running total | IN | OUT |
|---|---|---|---|
| One khata | what that book has **cost**, cumulatively | a reversal crediting spend back | spending charged to it |
| Whole wallet | the **wallet balance** — company cash still in hand | advances, reimbursements | spending, cash returned |

In both, a positive running total is **Dr** (the company is owed / out of
pocket) and a negative one is **Cr**, so the label means one thing everywhere.
Because the two scopes move opposite ways, every movement is printed with an
explicit `+`/`−` and the convention is spelled out in words on the summary card
— a reader must never have to work out which way round Dr is on a document
about their own money.

With `?from=`, the statement **opens on the figure carried in from before it**
rather than at zero, so consecutive statements join up.

### What is on it

* A **letterhead band** carrying the company logo (`Setting.branding.logoPath`
  → `ORG_LOGO_PATH` → the bundled `assets/logo.png`, via `services/branding.js`)
  on a white plate — the plate is there so a dark uploaded logo does not vanish
  into a dark bar.
* One block per **IST calendar day** with its own IN / OUT / net / running
  total, and the individual entries nested under it with time (12-hour), payment
  mode, kind, note, reference code and a bill thumbnail.
* **Reversed** rows still print, greyed and marked — financial history is never
  hidden — but they count for nothing; the mirror row is what moves the money.
* A **receipt page per bill** at the back, numbered `#N` to match the thumbnail,
  captioned with the entry's date, code and amount. Only JPEG and PNG can be
  drawn into a PDF, so the bytes are sniffed rather than the stored mime
  trusted; a PDF bill is noted as *"Bill on file"* instead. `RECEIPT_PAGE_CAP`
  (60) stops a year of a busy site book building a document nobody can email.

### The footer is SuperAdmin-editable

`Setting.documentFooter` — a help/contact number and one line of small print,
edited from **Admin → Permissions → Statement footer** on the web, or
**Admin → Branding → Statement footer** on mobile. It lives in the settings
singleton rather than `config/company.js` because that file is env-var constants
and changing the number a client is told to ring would otherwise need a deploy.
A blank number prints **no help line at all**, which is a legitimate choice for
a document that leaves the building.

---

## Integrations with the other money modules

Auto-posted through `services/khataSync.js`. Every hook is idempotent, records
company cash exactly once, and is best-effort — a failure never voids the loan
approval or reimbursement it mirrors.

| Source event | Ledger row | Company cash |
|---|---|---|
| Loan becomes `Active` | `to_employee` `advance` — wallet rises | only if the reviewer names a `cashAccount` |
| Loan repayment recorded | `from_employee` `salary_recovery` | only if a `cashAccount` is named |
| Expense **Approved** | `from_employee` `settlement` — company now owes them | none; the money left the *employee's* pocket |
| Expense **Reimbursed** | `to_employee` `reimbursement` — squares it off | none; `expenseController` already posted the cashbook entry |

> An expense **claim** posts as `settlement`, not `expense`. A claim is money the
> employee spent out of their *own* pocket, so it is not spending down an
> advance and belongs in no expense book — filing it as `expense` would demand a
> khata and would charge a site or a vehicle for something it never paid for.
> The wallet effect is identical either way.

The two expense legs net to zero. The reimbursement hook posts the approval leg
first if it is missing, so a claim taken straight to `Reimbursed` can never read
as though the employee *owed* what they were just paid back.

> **Known gap.** Payroll deducts an active loan EMI onto the payslip but does not
> reduce `Loan.balance` — only an explicit repayment does. That is pre-existing
> loan-module behaviour; the khata mirrors the loan's own balance movements
> exactly, so it is neither more nor less current than the loan record. A
> salary-recovered loan stays outstanding in the khata until the repayment is
> recorded against it.

---

## Tests

```bash
npm run test:khata
```

56 checks over the pure money rules — sign convention, ledger replay (including
back-dated inserts and paise drift), operator authorization, the auto-approve
threshold, credit limits, rounding, and the statement's own arithmetic (per-scope
signs, IST day grouping, reversed rows counting for nothing, and the statement
landing on the same figure `replayBalance` does). No database, about a second.

```bash
KHATA_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_khata_test" npm run test:khata:db
```

End-to-end against a real database: double-entry into the cashbook, idempotent
replays, parked-until-approved payouts, several books spending from one wallet,
reversals, back-dated re-stamping, and the executive sanction gate.

> It **refuses to run** unless `KHATA_TEST_MONGO_URI` is set to something other
> than `MONGO_URI`, because it creates and deletes data and this project's
> ordinary `MONGO_URI` points at the live cluster.

---

## Where the code lives

| Layer | Files |
|---|---|
| Models | `backend/models/EmployeeWallet.js` (the pot), `EmployeeKhata.js` (the books), `KhataEntry.js`; `operators[]` on `CashAccount.js`; `sourceKhataEntry` on `CashbookEntry.js`; `khataAdvanceApprovalRequired` and `documentFooter` on `Setting.js` |
| Money rules | `backend/services/khataLedger.js` — the only place balance arithmetic happens |
| Statement PDF | `backend/services/cashbookSummaryPdf.js` (category-wise summary layout + `summariseByCategory`), `streamStatement` in the controller (gathering the rows) |
| Integrations | `backend/services/khataSync.js` |
| API | `backend/controllers/khataController.js`, `backend/routes/khataRoutes.js` |
| Permissions | `khata.manage` in `backend/config/permissions.js`; `khataAccess` and `khataExportAccess` on `User`; `canExportKhata` + `requireKhataExport` + `canApproveAdvances` + `requireAdvanceApprover` in `backend/middleware/authMiddleware.js`; mirrors in `frontend/src/config/permissions.js` and `mobile/src/utils/roles.js` |
| Web | `frontend/src/pages/AdminKhata.jsx`, `EmployeeKhata.jsx`; the org switch and the statement-footer fields on `AdminPermissions.jsx`; `frontend/src/utils/download.js` |
| Mobile | `mobile/src/screens/KhataScreen.js`, `mobile/src/screens/admin/KhataAdminScreen.js`; the footer fields on `admin/BrandingScreen.js`; `mobile/src/utils/downloadFile.js` |

---

## Migration

Three scripts. All are dry-run by default and safe to re-run.

```bash
cd backend
node scripts/migrateMultiKhata.js --apply      # only if the database predates multi-khata
node scripts/migrateKhataWallet.js             # report what it would do
node scripts/migrateKhataWallet.js --apply     # do it
node scripts/confirmLegacyExpenses.js --apply  # when deploying the confirm/edit change
```

`confirmLegacyExpenses.js` closes the editing window on every expense recorded
*before* that window existed. Those rows carry no `confirmedByCompany`, which
reads as "never confirmed" — so without this they would all reappear in the
accounts team's confirm queue at once, and every employee could go back and
rewrite the amount on last quarter's spending. They were settled under the old
rules; this stamps them as what they effectively already were. `confirmedBy` is
left null on purpose: nobody pressed a button on them, and inventing an approver
would put a name against a decision that was never made.

`migrateMultiKhata.js` drops the obsolete `{ employee: 1 }` unique index (which
Mongoose creates but never removes, and which rejects an employee's *second*
book with an error that looks like a name clash and is nothing of the kind),
names any unnamed book "General", and marks one default per employee. The
creation paths call `ensureKhataIntegrity()` which does the same repair
automatically on first use, so an existing database heals itself — the script is
the deliberate version.

`migrateKhataWallet.js` is the one that matters for this change:

1. Opens an `EmployeeWallet` for everyone who has a khata, carrying in the **sum**
   of their old per-book opening balances and the **largest** limit any of their
   books carried. Summed because every one of those openings was money genuinely
   in that person's hand; the limit is a maximum rather than a total because
   adding them would hand somebody a bigger allowance than anyone ever approved,
   purely because their spending was filed under several headings.
2. Detaches every wallet-level row from its book — advances, settlements,
   reimbursements, recoveries, openings, and expense-*claim* mirrors. Reversals
   follow whatever they reverse.
3. Replays every book's `spent` and every wallet's `balance` from the ledger, so
   the new figures are **derived** rather than copied.

**The total is preserved.** A person's new wallet balance is the sum of their old
khata balances, because the same rows are being replayed — just against one pot
instead of several. The script prints both figures per person, so the dry run
shows you that before you commit to `--apply`, and flags anyone who comes out
different (which happens only where an old per-khata balance had drifted from
its own ledger — in which case the new figure is the correct one).

## Setting it up

1. **Grant access** — Permissions page → *Khata* column: **Grant access** opens
   the module for anyone (or switch on `khata.manage` for the HR Managers who
   need it). **Allow export** is the separate download grant — give it only to
   the people who should be able to take the whole ledger out as a spreadsheet.
2. **Decide on the approval gate** — Permissions page → **CEO / MD approval for
   cash advances**. On by default. Turn it off if the accounts team should
   handle requests directly.
3. **Name the operators** — Admin → Employee Khata → Accounts → *Manage
   operators* on each cash account. Until you do, only a SuperAdmin can pay
   anyone from it. Set each person's direct-payout limit here.
4. **Set advance limits** (optional) — Admin → Employee Khata → People → a
   person → **Wallet settings**. Per person, across all their books.
5. **Carry balances in** (optional) — a SuperAdmin can set an opening balance on
   any wallet, for money already in someone's hand before the module existed.
6. **Let people open their own books** — employees name them from My Khata as
   they take on new work; everyone gets a "General" one automatically.

> **A khata card reading a negative "spent" means the migration has not been
> run** on that database. The books still contain advances filed under them from
> the per-khata era; `migrateKhataWallet.js --apply` detaches those and replays
> every total.
