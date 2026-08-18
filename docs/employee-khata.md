# Employee Khata — company ↔ employee cash ledger

Khatabook-style running accounts between the company and each member of staff:
advances handed out, cash settled back, and a balance that says, in plain words,
whether they owe the company or the company owes them.

**An employee can hold several named khatas.** A site supervisor might carry a
float for "Site A — materials", another for "Vehicle & fuel", and a salary
advance besides. Lumping those into one number would make it impossible to say
what any of it was for, or to close one off on its own. So money is always given
to and settled against a *specific* book; a person's overall position is the sum
of theirs.

It sits **on top of** the existing cashbook rather than replacing it. The
cashbook answers *"how much is in the tin?"*. The khata answers *"how much is
Rahul holding right now, and what has he settled?"* — a question the cashbook
could never answer, because there a payout is just a flat line with a party name
on it.

---

## The one rule everything rests on

Balances are held from the **company's** point of view, and the direction of the
money is the only thing that sets the sign:

| Direction | Meaning | Effect | Company sees | Employee sees |
|---|---|---|---|---|
| `to_employee` | company → employee | `balance += amount` | **You will get** | You owe the company |
| `from_employee` | employee → company | `balance -= amount` | **You will give** | The company owes you |

`type` (`advance`, `settlement`, `expense`, `reimbursement`, `salary_recovery`,
`opening`, `reversal`, `other`) is only ever a reporting label — it never
changes the arithmetic.

The words "debit" and "credit" appear nowhere in the UI. Both apps take their
wording from the server (`describeBalance` / `describeBalanceForEmployee`) so
they cannot drift apart on the most confusable thing in the module.

## Three guarantees

1. **The balance cannot drift.** It is never incremented in place. After any
   change the whole ledger is replayed from the opening balance
   (`replayBalance` → `recomputeKhataBalance`), so a back-dated entry also
   re-stamps every later running balance.
2. **Company cash and the employee ledger move together.** An advance leaving
   the petty-cash tin also posts a `CashbookEntry`, cross-linked both ways
   (`KhataEntry.cashbookEntry` ↔ `CashbookEntry.sourceKhataEntry`).
3. **Posted money is never deleted.** A correction is a *reversal*: the original
   is marked `Reversed` and a mirror row is written against it, on both books.
   The ledger reads `₹5,000 out, ₹5,000 back, ₹4,500 out` — never a row that
   silently changed.

---

## Who can give money — two gates, deliberately separate

Holding the capability opens the module. It pays nobody on its own.

**Gate 1 — `khata.manage`** opens the khata screens. Granted by: SuperAdmin
(implicitly), AccountsManager (by role), an HR Manager or Manager holding the
capability, or **anyone at all** via the standalone `User.khataAccess` flag — so
the branch supervisor who actually hands out cash needs no admin role.

**Gate 2 — `CashAccount.operators`** decides whose money you may touch. Each
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

---

## Several books per person

| Rule | Why |
|---|---|
| Names are unique per employee | "Site A" must mean one thing for one person. A duplicate is rejected, not silently created alongside. |
| Exactly one `isDefault` book | Where self-service lands when no book is named. Opened lazily as **"General"** on first use, so an employee can ask for ₹500 before anyone has organised anything. |
| A book with a balance cannot be closed | Closing would hide a live balance from the outstanding list and quietly write off what is owed. Settle first. |
| The default book cannot be closed | Self-service would have nowhere to put a request. Promote another book first. |
| An entry naming another employee's book is refused | Without this check, a request carrying somebody else's khata id would post one person's advance onto another person's ledger. |

Limits are **per book**, not per person — a ₹50,000 site float and a ₹5,000
petty float want very different ceilings.

**Both sides can open a book.** A khata operator opens one for anybody
(`POST /khatas`); an employee opens one on their own account
(`POST /me/khatas`, capped at 25). Deciding that a float needs its own ledger is
part of doing the job, and opening a book moves no money — so it needs no
approval. What an employee still cannot do is put cash on it, set its limit, or
make it the default; and an operator still cannot exceed their own account
limits. An employee opening a book notifies the khata operators so a limit can
be set if it needs one.

### Totals are never netted

Both sides are always carried in full — `splitTotals` returns `{ get, give, net }`
and the screens show `get` and `give` side by side whenever both are non-zero.
Somebody owing ₹5,000 on a site float while the company owes them ₹2,000 for
their own spend genuinely has both; collapsing that to "₹3,000 receivable" is how
a company forgets to pay somebody back. Each khata settles on its own, so the two
figures do not cancel out.

## Guard rails

- **Credit limit** (`EmployeeKhata.creditLimit`, `0` = none) — an advance that
  would take that *book* past it is refused. Re-checked at approval time, not
  trusted from submission, because a request can sit in the queue while other
  entries move the balance. Settlements are **never** blocked: nobody should be
  stopped from handing money back.
- **Idempotency** — `KhataEntry.idempotencyKey` means a double tap or a mobile
  retry over a flaky link returns the original row instead of paying twice.
- **Opening balance** is SuperAdmin-only. It is the one figure that moves a
  balance with no ledger row behind it.
- **Employees never self-release.** `POST /khata/me/request` and `/me/settle`
  always park as `Pending`, whatever permissions the caller holds.

---

## API

Mounted at `/api/khata`. All routes authenticated.

**Employee self-service** — any user, own khata only

| Route | Purpose |
|---|---|
| `GET /me` | All my books, each balance, the combined total, and one statement |
| `POST /me/request` | Ask for an advance — body `khata` picks the book |
| `POST /me/settle` | Declare cash returned — body `khata` picks the book |
| `POST /me/khatas` | Open a book on my own account (name only — the limit stays the company's call) |

**Operators** — all require `khata.manage`

| Route | Purpose |
|---|---|
| `GET /overview` | Receivable / payable totals, pending count, my accounts |
| `GET /accounts` | Accounts I may pay from, with my limits |
| `GET /employee-options` | Thin employee picker (no salary or personal data) |
| `GET /employees` | **One row per person** — combined total plus their per-book breakdown |
| `GET /employees/:id` | One person's books and statement (`?khata=` narrows it) |
| `POST /khatas` | Open a new named book for someone |
| `PUT /khatas/:khataId` | Rename, limit, note, make default, close/re-open (opening balance ⇒ SuperAdmin) |
| `POST /entries` | Give an advance / record a settlement — body `khata` picks the book |
| `GET /entries` · `GET /pending` | Ledger · approvals queue |
| `PATCH /entries/:id/approve` · `/reject` | Release · decline (approve needs `canApprove`) |
| `POST /entries/:id/reverse` | Cancel with a mirror row; reason required |
| `GET /reports/outstanding` | Who is holding cash, with ageing bands |
| `GET /reports/export` | Balances + full ledger as `.xlsx` |
| `POST /reports/remind` | Nudge everyone holding company cash |

**SuperAdmin only**: `GET|PUT /accounts/:id/operators`,
`POST /khatas/:khataId/recompute` (repair tool — rebuild one book's balance from
its ledger, for use after a direct database edit or a restored backup).

---

## Integrations with the other money modules

Auto-posted through `services/khataSync.js`. Every hook is idempotent, records
company cash exactly once, and is best-effort — a failure never voids the loan
approval or reimbursement it mirrors.

| Source event | Khata row | Company cash |
|---|---|---|
| Loan becomes `Active` | `to_employee` for the principal | only if the reviewer names a `cashAccount` |
| Loan repayment recorded | `from_employee` | only if a `cashAccount` is named |
| Expense **Approved** | `from_employee` — company now owes them | none; the money left the *employee's* pocket |
| Expense **Reimbursed** | `to_employee` — squares it off | none; `expenseController` already posted the cashbook entry |

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

33 checks over the pure money rules — sign convention, ledger replay (including
back-dated inserts and paise drift), operator authorization, the auto-approve
threshold, credit limits, and rounding. No database, runs in about a second.

```bash
KHATA_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_khata_test" npm run test:khata:db
```

End-to-end against a real database: double-entry into the cashbook, idempotent
replays, parked-until-approved payouts, reversals, and back-dated re-stamping.

> It **refuses to run** unless `KHATA_TEST_MONGO_URI` is set to something other
> than `MONGO_URI`, because it creates and deletes data and this project's
> ordinary `MONGO_URI` points at the live cluster.

---

## Where the code lives

| Layer | Files |
|---|---|
| Models | `backend/models/EmployeeKhata.js`, `KhataEntry.js`; `operators[]` on `CashAccount.js`; `sourceKhataEntry` on `CashbookEntry.js` |
| Money rules | `backend/services/khataLedger.js` — the only place balance arithmetic happens |
| Integrations | `backend/services/khataSync.js` |
| API | `backend/controllers/khataController.js`, `backend/routes/khataRoutes.js` |
| Permissions | `khata.manage` in `backend/config/permissions.js`; `khataAccess` on `User`; mirrors in `frontend/src/config/permissions.js` and `mobile/src/utils/roles.js` |
| Web | `frontend/src/pages/AdminKhata.jsx`, `EmployeeKhata.jsx` |
| Mobile | `mobile/src/screens/KhataScreen.js`, `mobile/src/screens/admin/KhataAdminScreen.js` |

---

## Migration (self-healing, but the script is still there)

The creation paths call `ensureMultiKhataIndexes()`, which drops the obsolete
index automatically on first use and logs when it does. So an existing database
fixes itself the first time anyone opens a khata. The script below does the same
thing deliberately, plus the naming and default-marking, and is worth running on
a database that predates this change:

```bash
cd backend
node scripts/migrateMultiKhata.js          # report what it would do
node scripts/migrateMultiKhata.js --apply  # do it
```

`EmployeeKhata.employee` used to be `unique: true`. **Removing that from the
schema does not remove the index from MongoDB** — Mongoose only ever creates
indexes, never drops them. Left in place, it rejects an employee's *second* khata
with a duplicate-key error that looks like a name clash and is nothing of the
kind. The script drops it, names any unnamed book "General", marks one default
per employee, and builds the new `{ employee, name }` unique key. Safe to run
more than once.

If the automatic drop ever fails (no permission, say), `openKhata` checks whether
a book of that name actually exists before blaming the name, and otherwise says
plainly that the old index is still there.

## Setting it up

1. **Grant access** — Permissions page: switch on `khata.manage` for the HR
   Managers who need it, or set `khataAccess` on whoever actually hands out cash.
2. **Name the operators** — Admin → Employee Khata → Accounts → *Manage
   operators* on each cash account. Until you do, only a SuperAdmin can pay
   anyone from it. Set each person's direct-payout limit here.
3. **Open the books people need** — Admin → Employee Khata → People → **+ New
   khata**, from inside a person, or straight from the give-money form.
   Employees can open their own from My Khata. Everyone gets a "General" book
   automatically; name the others after what they are for.
4. **Set limits** (optional) — per book, under *Settings* on that book.
5. **Carry balances in** (optional) — a SuperAdmin can set an opening balance on
   any book, for money already owed before the module existed.
