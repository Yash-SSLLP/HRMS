# Task Module

Reworked **2026-09-21**, replacing the twelve-status workflow engine of
2026-09-17. The brief was a task app a business owner can work without being
taught: three states, one form, one update box.

This is the module's map: what is where, why the shape is what it is, and the
handful of rules that are load-bearing enough to be worth writing down twice.

---

## 1. What it does

Somebody hands work over. Somebody else does it and says so. Everybody who
cares hears about it. That is the whole module.

- **hand it over** — to one person or several, with a deadline, a priority, a
  category, files, links and a **voice note**
- **answer it** — accept it, decline it with a reason, or **delegate** it on
- **split it** — subtasks, each owned by somebody or open to anybody on the task
- **explain it out loud** — a recording beats a paragraph nobody reads, and the
  doer can answer in their own language
- **work on it** — start it, finish it, say something about it, attach proof
- **chase it** — reminders before the deadline and after it, by push or email
- **repeat it** — daily, weekly, monthly, yearly
- **reuse it** — templates, and a shared starter directory
- **score it** — points, and a dashboard that says who is on top of their work
- **ask upward** — a *request*, which is not a task (§3)

### What was deliberately removed

The workflow builder, parallel and conditional approval steps, the dependency
graph, the checklist, custom fields, the evidence contract, the geofence, the
timer and timesheets, extension requests, the incentive sanction queue, and
event-raised tasks. About 10,000 lines. None of it was used; all of it was in
the way.

**Three of them came back on 2026-09-21 in a much smaller form**, at the user's
request, and the difference is the point:

| removed | what replaced it |
|---|---|
| the checklist + child tasks | **subtasks** — a title, an optional owner, a tick. No deadline, no points, no feed |
| the approval ladder | **accept / decline** — one field on the assignee row, not a chain of steps |
| handover | **delegate** — the doer passes their own piece on, and keeps being notified |

---

## 2. Architecture at a glance

```
config/tasks.js                the whole vocabulary: 3 states, the legal moves,
                               priorities, frequencies, reminder maths, and the
                               legacy status map
  │
services/taskEngine.js         THE ONLY WAY A STATUS MOVES
  ├── taskAccess.js            direction (down/peer/up) + who sees what
  ├── taskPoints.js            completion → points → IncentiveCredit
  ├── taskNotify.js            every notification the module sends
  ├── taskReminderWorker.js    the chasing, and the daily digest
  └── taskRecurrenceWorker.js  repeating tasks

controllers/
  taskController.js            the task: CRUD, status, feed, files, categories
  taskTemplateController.js    templates, the directory, repeating schedules
  taskDashboardController.js   the scoring table

routes/taskRoutes.js           /api/tasks — one router, ~20 routes
```

One router. `/api/task-workflows` is gone.

---

## 3. The direction rule — tasks go down and across, never up

Work travels DOWN the reporting line or ACROSS it. It does not travel up.

| direction | to whom | what it makes |
|---|---|---|
| DOWN | your reports, direct or indirect | a **TASK** |
| PEER | somebody at your own level | a **TASK** |
| UP | your manager, or anyone senior | a **REQUEST** |

**Why.** A task is SCORED: it lands in somebody's completion rate, their In
Time / Delayed split and their points. If a junior could set one on their
manager, the manager's figures would be partly written by the people reporting
to them, and the honest response would be to stop using the module. But juniors
genuinely need things from above — the April figures, an approval, a decision —
and having no way to ask is how a portal ends up with a task called "Sir please
send data". So the upward ask is a first-class row with the same feed, the same
voice notes and the same three states, and it is simply not counted as work the
senior was set. *(User decision, 2026-09-21.)*

**How seniority is decided** (`services/taskAccess.directionOf`), cheapest test
first:

1. Is the target in the actor's own management chain? Then UP.
2. Otherwise compare DEPTH below the top of the reporting tree. Strictly
   shallower means senior — so a clerk in Sales cannot set a task on the Head of
   Accounts, who is in nobody's chain but their own.

When depth cannot be established for either party — the reporting line is
incomplete, which it is for real people in every HRMS — the answer is PEER and
the task is allowed. A missing manager must not silently stop somebody working.

**Exempt:** `tasks.manage` holders, CEO/MD and SuperAdmin. They are the top of
the tree; every direction from there is down.

**Assigning is not a privilege.** `POST /api/tasks` has no capability gate —
everybody can set a task. What `tasks.manage` buys is the wide view: All Tasks,
the team dashboard, and removing a category.

---

## 4. The lifecycle

```
PENDING ──start──> IN_PROGRESS ──complete──> COMPLETED
   └──────────────complete──────────────────────┘
   └──cancel──> CANCELLED      (the assigner calls it off)
```

Everything else a list says is **derived**, never stored — a stored value goes
stale the moment a clock ticks past it:

| shown as | is really |
|---|---|
| **Overdue** | open, and past its due date |
| **In time** | completed, `completedLate === false` |
| **Delayed** | completed, `completedLate === true` |

`completedLate` is **frozen** on the assignee row at the moment they finish,
never re-derived. Extending a deadline afterwards must not turn a late delivery
into a punctual one.

### Acceptance is a SECOND AXIS, not a fourth status

Added 2026-09-21 (second pass). It would have been easy to make this
`ASSIGNED → ACCEPTED → IN_PROGRESS`, and that is exactly what the twelve-status
version did on its way to twelve. They answer different questions:

| | question |
|---|---|
| `status` | how far along the **work** is |
| `acceptance` | whether the **person** has agreed to do it |

They move independently. Somebody can accept and not start, or **start without
ever pressing Accept** — the common case, and it must stay legal: chasing an
acknowledgement for work that is already done is the ceremony this module
exists to remove. Starting or completing therefore sets acceptance implicitly.

| acceptance | meaning |
|---|---|
| `AWAITING` | handed over, not answered |
| `ACCEPTED` | taken on |
| `REJECTED` | refused, **with a reason** (the server requires one) |

Two more DERIVED states fall out of it, neither of them stored:

- **Not yet accepted** — somebody is sitting on an unanswered handover
- **Declined** — *everybody* still on it has refused. The work is owed and
  nobody is doing it, which is not any of the three statuses. The assigner has
  to reassign, delegate or call it off.

**A refusal does not hold the roll-up open.** Four people finish, one declined
— that is a finished task. Leaving it In progress for ever is how a list fills
with work nobody is doing.

### Delegating — the doer hands their own piece on

Not the same as reassigning (`PATCH /:id`, which is the *assigner's*). Three
rules:

1. **The direction rule applies.** Down or across, never up — otherwise
   delegation is the hole in the wall the whole task/request split exists to
   close.
2. **The delegator keeps hearing about it.** They leave `assignees` but stay in
   `originalAssignees`, so every later notification still reaches them. This is
   the user's rule: *"the user who got the task in the beginning will receive
   notification for every update"*. It is deliberately NOT `loopUsers` — the
   loop is a choice the assigner can undo, this is a fact about the task's
   history and cannot be.
3. **The new person starts fresh** — AWAITING, PENDING, no inherited progress.
   They can accept or decline exactly as if it had been set on them, which is
   the point of delegating rather than quietly swapping a name.

### Subtasks — "pieces"

Embedded on the task (`Task.subtasks`), not child Task documents: a task page
stays ONE query, and a subtask has no deadline, points, reminders or feed of
its own. Capped at 50 — past that the right answer is two tasks.

| | who may tick it |
|---|---|
| **named** (`assignee` set) | its owner, or whoever set the task |
| **open** (`assignee` null) | **anybody on the task** — the user's "any assignee can do any subtask" |

Somebody named on a subtask can **see the parent task** even when they are not
on it, or the piece would be invisible to the only person who can do it.

Ticking every piece does not auto-complete the parent, and an open piece does
not block completing it. The progress line says "2 of 5"; the person decides.

### Every move says something out loud

You cannot move a task silently. The update box will not submit empty — though
**a voice note counts**, which on a phone is the point. That is the mechanism by
which a completed task carries a record of what was actually done rather than a
green tick and a shrug. Enforced on the server (`taskEngine.move`), so an older
client cannot slip a silent completion past it.

### Per person, then rolled up

A task on three people is three jobs. A move lands on the mover's OWN assignee
row; `Task.status` is recomputed from all of them (`models/Task`):

- all done → COMPLETED (finished when the LAST person did; late if ANY was late)
- anybody started → IN_PROGRESS
- otherwise → PENDING
- CANCELLED is set directly — the assigner overruling everybody at once

---

## 5. Data model

| Collection | What it holds |
|---|---|
| **Task** | the work, its people, its recording, its schedule and its points |
| **TaskUpdate** | ONE feed — status moves, remarks, files. Append only |
| **TaskCategory** | the managed category list, per company |
| **TaskTemplate** | a task worth setting again; `directory: true` = shared |
| **RecurringTask** | a schedule; the tasks it makes are ordinary Tasks |

`TaskActivity`, `TaskComment`, `TaskSubmission`, `TaskTimeEntry`,
`TaskExtension`, `TaskIncentive` and `Workflow` are **retired**. Their data is
folded into `TaskUpdate` by the migration; the collections are left untouched.

### Indexes

```
{ assignedTo: 1, status: 1, dueDate: 1 }        "my open tasks, soonest first"
{ 'assignees.user': 1, status: 1, dueDate: 1 }  the same for a co-assignee
{ createdBy: 1, status: 1, dueDate: 1 }         "what I delegated"
{ company: 1, kind: 1, status: 1, dueDate: 1 }  every walled admin list
{ status: 1, dueDate: 1 }                       the overdue sweep
{ loopUsers: 1, status: 1 }                     "tasks I am kept in loop on"
{ recurringTask: 1, occurrenceKey: 1 }          UNIQUE, sparse — see §8
```

---

## 6. Points

**Every task is worth 100 points unless the assigner says otherwise.** One
figure, earned by EACH person on it — no split arithmetic. A four-way split is
typing 25. *(User decision, 2026-09-21.)*

The default lives in `Setting.tasks.defaultPoints`.

### Scoring always; paying only if you turn it on

Points are this portal's one currency and they settle in rupees
(`Setting.incentive.rupeePerPoint`), shared with the rolling and billing
incentives. So completing a task **always records** its points — on the
assignee row, in every report, on the dashboard — but it only writes an
`IncentiveCredit`, and so only becomes payable, when a SuperAdmin turns on
**`Setting.tasks.pointsToPool`**. Default **off**.

That split is deliberate: scoring is what the dashboard needs and should work
out of the box; paying is a payroll decision and should be made on purpose,
once, by somebody who can make it. Turning it on affects tasks completed from
that moment — it does not backfill.

Reopening a completed task takes the points back by deleting the credit, unless
that month has already been PAID, in which case the credit is left alone and the
reopen is recorded without it. That money is gone, and silently clawing it back
is how a payslip stops reconciling.

A **request** always carries 0 points.

---

## 7. Voice notes

The feature the brief would not do without, and the one most likely to be used
by the people this portal actually serves.

| | web | app |
|---|---|---|
| record | `MediaRecorder`, container negotiated (webm/mp4/ogg) | `expo-av`, HIGH_QUALITY preset |
| play | `<audio>` off a blob fetched with the auth header | `Audio.Sound` with an `Authorization` header |
| store | GridFS via `services/storage`, metadata on the row | same |

Three traps, each paid for once:

- **The container is not portable.** Chrome gives webm, Safari gives mp4, and
  asking for one the browser lacks throws. `pickMimeType()` negotiates.
- **expo-av's audio mode is global and sticky.** `allowsRecordingIOS: true`
  routes playback to the earpiece for the whole app — the course player two
  screens later goes quiet and nobody connects the two. It is restored on every
  exit path.
- **Everything must be released by hand** — the MediaStream, the `Recording`,
  the `Sound`. Otherwise: a lit recording indicator, a held microphone, and a
  native player leaked per voice note in a feed.

A voice note is its OWN field, not one of the attachments: it has a player, a
duration and top billing, and finding it by MIME-sniffing an array works right
up until somebody uploads an .mp3 of something else.

---

## 8. Recurrence

Ticking Repeat creates a `RecurringTask`; the worker mints an ordinary Task per
occurrence. Those tasks are worked, scored and reported exactly like a one-off —
nothing else in the module knows recurrence exists.

**The occurrence key is the whole safety mechanism.** Every minted task carries
`occurrenceKey` (the IST day it is for) under a UNIQUE compound index with
`recurringTask`. A worker restart, two server instances, a catch-up over a week
the machine was down: each tries to insert a key that already exists and gets a
duplicate-key error instead of a second copy of Monday's task. Idempotence by
database constraint, not by remembering to check.

Catch-up is capped at `CATCHUP_DAYS = 7`. Uncapped, restoring a backup from last
quarter would hand somebody ninety tasks in one push — very close to the trap
this module's previous version fell into when a backlog sweep fired 51 overdue
notifications on its first morning.

---

## 9. Reminders

A rule is `{ channel, amount, unit, when }` — "APP, 1, DAYS, BEFORE".

**Channels are APP and EMAIL.** The brief asks for WhatsApp; this portal has no
WhatsApp Business sender, and a channel that silently drops every message is
worse than one that is not offered. If a sender is ever connected it slots into
`config/tasks.REMINDER_CHANNELS` and the worker needs one more case.

Three rules in `services/taskReminderWorker`, each there because something went
wrong once:

1. **A rule fires at most once.** Fired keys are recorded on the task and the
   claim is a CONDITIONAL update, so two instances racing one tick cannot both
   send it.
2. **Nothing older than 90 minutes fires at all.** A rule whose moment has long
   passed is marked fired WITHOUT being sent — a server down overnight must not
   deliver yesterday's four reminders at breakfast.
3. **After-the-deadline reminders go UP.** They reach the doers and the assigner
   and the loop, because by then it is news the assigner needs rather than a
   nudge the doer has already ignored.

The evening digest (`Setting.tasks.dailyDigestAt`) is ONE notification per
person — "you have 4 pending" — not one per task.

---

## 10. Categories

Free text became a managed list (`models/TaskCategory`).

- **Anybody can add one** — the + beside the picker. Somebody filing the first
  task for a new project at nine at night should not wait for an admin.
- **Only a SuperAdmin can rename or remove one**, because that hides the label
  from everybody and from every filter — a company decision, not a supervisor's.
  *(User decision, 2026-09-21.)*
- Unique per company, **case-insensitively**, so "sales" cannot appear beside
  "Sales" — the exact problem the collection exists to end.

A task stores the category's **NAME**, not its id, so removal has two paths:

| state | what happens |
|---|---|
| nothing filed under it | really deleted, and the name is freed |
| tasks filed under it | **hidden**; those tasks keep their label |
| `?moveTo=<name>` | the tasks are refiled first — the honest way to merge two |

Wiping `category` off two hundred rows to tidy a dropdown is destroying records
to fix a list.

---

## 10a. Removing a task

| | who | what happens |
|---|---|---|
| **Archive** (default) | whoever set it, `tasks.manage`, **or any SuperAdmin** | disappears from every list; the feed, the files and any credited points stay on file |
| **Purge** (`?purge=1`) | **SuperAdmin only** | really gone, feed and all. **Refused** once points have been credited — the `IncentiveCredit` would outlive the only record of what it was for |

A SuperAdmin may remove **any** task, whoever set it (user decision,
2026-09-21). The two are separate buttons rather than a flag on one, because
"archive" and "gone for ever" should not be one slip apart.

---

## 11. The dashboard

One table, a row per person: what they were given, what is not done, what is
done, whether it was on time, and what they earned.

The percentages are shares **within each half** — "4 (19%)" is 19% of what is
not done, not 19% of everything. Two scores, not one:

- **score** — how much of what they were given is finished
- **onTimeScore** — how much of THAT was punctual

Somebody who finishes everything a week late and somebody who finishes nothing
are different problems, and one number cannot say both.

**What a row counts depends on the tab, on purpose:**

| tabs | grain |
|---|---|
| Employee / My report / Delegated | per PERSON (`$unwind` over assignees) |
| Category / Over time | per TASK |

So the employee tab's total and the category tab's total need not match, and on
a multi-assignee task they will not.

---

## 12. Counters

Above every list: Overdue · Pending · In progress · Completed (→ In time /
Delayed).

**The boxes do not overlap.** Every task is counted in exactly one of the first
four, so they sum to the total and the row can be trusted. Overdue wins over
Pending and In progress — a late task is late, and counting it in both makes the
red figure meaningless and the arithmetic wrong.

Counters and rows come from **ONE filter built once** (`buildQuery`). Built
separately they would drift, and a counter that disagrees with the rows beneath
it is worse than no counter.

---

## 12a. The endpoints the second pass added

```
POST   /api/tasks/:id/accept              take it on
POST   /api/tasks/:id/decline             refuse it   { reason }   ← required
POST   /api/tasks/:id/delegate            pass it on  { to, note }
POST   /api/tasks/:id/subtasks            split it    { items: [{title, assignee?}] }
PATCH  /api/tasks/:id/subtasks/:subId     tick / un-tick
DELETE /api/tasks/:id/subtasks/:subId     remove a piece
DELETE /api/tasks/:id?purge=1             SuperAdmin: delete for good
```

None of the first three is a status move: accepting is an acknowledgement,
declining hands the problem back without cancelling anything, and delegating
changes *who* rather than *where*. All are gated by IDENTITY inside the engine
— only somebody actually on the task may use them, so an assigner cannot
accept on a doer's behalf.

**`can` now comes down with every LIST row**, not just on the detail response
(`taskController.listTasks`). The list draws Accept / Decline / In progress /
Complete straight on the row and opens the same update box the detail page
does, so it needs the same answer to "what may this person do to this task".
It is in-memory work over at most 200 rows and no extra query — the
alternative is the client re-deriving the rules, which is the split-brain this
module was rebuilt to end.

---

## 13. Migrating

```bash
node scripts/migrateTasksV3.js          # report what it would do
node scripts/migrateTasksV3.js --apply  # do it
```

Idempotent; safe to re-run. It:

1. maps every status — both the twelve of 2026-09-17 and the four before them
2. reconstructs `completedLate` once, from `completedAt` against `dueDate`
3. gives every task the default points — and credits **nobody** retroactively
4. folds TaskActivity + TaskComment + TaskSubmission into TaskUpdate, keyed on a
   `migratedFrom` marker so a second run copies nothing
5. moves `watchers` to `loopUsers`
6. seeds TaskCategory from the categories already in use

The model's own hooks apply the same status map, so a row the migration has not
reached is still a valid document and an un-updated Android build still works.

---

## 14. Testing

```bash
npm run test:tasks      # 79 assertions, no database, about a second
```

Covers the status vocabulary (old and new), the transition table, overdue
derivation, reminder arithmetic, the recurrence calendar (including the 31st
clamping into February), the model's roll-up hooks, and — since the second
pass — the acceptance axis, the rule that a refusal must not hold the roll-up
open, subtask ownership, and the fact that `originalAssignees` is stamped once
and never rewritten.

**The model tests use `validate()`, not `validateSync()`.** Mongoose runs NO
middleware on validateSync — the pre-validate hooks that normalise a status and
roll the assignees up simply do not fire, and a test written against it passes a
document the application would never produce. This cost half an hour once.
