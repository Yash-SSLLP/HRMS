# Task Module

Reworked **2026-09-22** (third pass), on top of the 2026-09-21 rework that
replaced the twelve-status workflow engine of 2026-09-17. The through-line has
not changed: a task app a business owner can work without being taught.

This is the module's map: what is where, why the shape is what it is, and the
handful of rules that are load-bearing enough to be worth writing down twice.

### What the 2026-09-22 pass added, and why each earned its place

| | the brief | what it is |
|---|---|---|
| **pieces** | *"manager can divide that task into multiple subtask and assign that to their team member"* | a piece is a **task of its own** now (§4b), with its own points, deadline, progress and submission |
| **point distribution** | *"they can do the point distribution to those task, by default it will be divided equally"* | the parent's points are a **pool** the pieces draw from (§6) |
| **progress** | *"they can put how much progression they did till now"* | a declared 0–100 on each person's row, rolled up by points (§4c) |
| **a review step** | *"when user submit any task then manager should have the option to approve that and on reject that submission the task will reopen again"* | a fourth state, `SUBMITTED` (§4) |
| **more time** | *"requesting more time for that"* | an append-only request the assigner answers (§4d) |
| **team-first pickers** | *"only show the team member for manager and for CEO and MD show Manager who are under them but they can search other people"* | every dropdown opens on your own branch (§3a) |
| **colour** | *"if any task is pending then the whole task should be in the priority color … if completed show that in Green"* | one palette, served by the API (§2a) |
| **a board** | a Jira-style four-column screenshot | `GET /tasks/board` and the List/Board switch (§11a) |
| **serials and sorting** | *"give serial number to these task and give option to sorting"* | `row.serial` and six sort keys (§11b) |

…and a fourth pass the same day, from a second round of instructions:

| | the brief | what it is |
|---|---|---|
| **two boards on one page** | a drawing of "Assign to me" and "Assign by me", four columns each | the same board endpoint called twice, `scope=mine` and `scope=delegated` (§11a) |
| **accepting starts it** | *"in todo all the assigned task will come, after accepting that it will come to in progress"* | `POST /:id/accept` now moves the row to IN_PROGRESS; there is no separate Start button |
| **the approval follows the work** | *"for delegate who is doing delegate he should be the approvar for that chain"* | `Task.approver`, moved on every delegation (§4e) |
| **Transfer** | *"if the task is assigned to wrong user then they can transfer to anyone and it will be fully transferred"* | `POST /:id/transfer` — the opposite of delegate in who stays answerable (§4f) |

Exactly **one** status was added to do all of that. The temptation was four.

---

## 1. What it does

Somebody hands work over. Somebody else does it, or breaks it up and hands the
pieces on. They say how far along they are, and they hand it in. Somebody says
yes or sends it back. Everybody who cares hears about all of it.

- **hand it over** — to one person or several, with a deadline, a priority, a
  category, files, links and a **voice note**
- **answer it** — accept it, decline it with a reason, **delegate** it on, or
  **ask for more time**
- **split it** — into **pieces, each a task of its own**, carrying a share of
  the points; a piece may be given to somebody or left open for anybody on the
  team to pick up
- **explain it out loud** — a recording beats a paragraph nobody reads, and the
  doer can answer in their own language
- **work on it** — start it, say how far along you are, hand it in, attach proof
- **review it** — the person who set it approves the submission or sends it back
- **chase it** — reminders before the deadline and after it, by push or email
- **repeat it** — daily, weekly, monthly, yearly
- **reuse it** — templates, and a shared starter directory
- **score it** — points, and a dashboard that says who is on top of their work
- **see it** — as a list with serials and six sorts, or as a four-column board
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

**Two of those went round again on 2026-09-22**, and it is worth being honest
about it rather than quietly reversing yesterday's reasoning:

| 2026-09-21 said | 2026-09-22 says | why |
|---|---|---|
| a piece is an EMBEDDED row, because "a task page stays one query" | a piece is a **child Task** | the brief asks a piece to carry points, a deadline, progress, acceptance, a submission and a feed, and to appear in its owner's own list. Every one of those is a field a Task already has. Keeping them embedded would have meant growing the embedded row into a second, worse Task and duplicating the engine to drive it. The property traded away is real — a task page costs two queries now instead of one — and that is the whole cost. |
| there is NO approval step; the doer presses Complete and it is done | a doer's Complete is a **submission**, and the assigner approves it | the brief asks for it in so many words. It is **one** state, not the twelve that were removed, and it answers a question none of the other three can: the work is out of the doer's hands and not yet accepted. It is also skippable — `requiresApproval` is a checkbox. |

The twelve-status machine is still gone, and nothing here brings back the
workflow builder, the conditional branches, the dependency graph or the evidence
contract.

---

## 2. Architecture at a glance

```
config/tasks.js                the whole vocabulary: 4 states, the legal moves,
                               the review rule, priorities AND THEIR COLOURS,
                               progress, sorts, frequencies, reminder maths,
                               and the legacy status/priority maps
  │
services/taskEngine.js         THE ONLY WAY A STATUS MOVES
  │                            …and the only way a task is split, claimed,
  │                            progressed or extended
  ├── taskAccess.js            direction (down/peer/up), the reporting tree
  │                            BOTH WAYS, who sees what, and `can`
  ├── taskPoints.js            completion → points → IncentiveCredit
  ├── taskNotify.js            every notification the module sends
  ├── taskReminderWorker.js    the chasing, and the daily digest
  └── taskRecurrenceWorker.js  repeating tasks

controllers/
  taskController.js            the task: CRUD, status, submit/approve/reject,
                               progress, split, claim, extensions, the LIST,
                               the BOARD, the feed, files, categories
  taskTemplateController.js    templates, the directory, repeating schedules
  taskDashboardController.js   the scoring table

routes/taskRoutes.js           /api/tasks — one router, ~30 routes
```

One router. `/api/task-workflows` is gone.

## 2a. The colour of a task — one rule, served by the API

The brief: *"if any task is pending then the whole task should be in the
priority color, and if the task is completed then show that in Green"*. So this
is not a chip's palette. It is the accent behind an entire row, board card and
detail header, in two clients.

```
accent = COMPLETED  → green
       | CANCELLED  → grey, and the row is drawn faded
       | otherwise  → the priority's colour
```

Three priorities, changed from `High / Medium / Low` on 2026-09-22:

| | ink | tint | hairline | rail |
|---|---|---|---|---|
| **Urgent** | `#B42318` | `#FEF3F2` | `#FDA29B` | `#D92D20` |
| **Medium** | `#B54708` | `#FFFAEB` | `#FEC84B` | `#F79009` |
| **Low** | `#475467` | `#F2F4F7` | `#D0D5DD` | `#98A2B3` |
| **Done** | `#027A48` | `#ECFDF3` | `#6CE9A6` | `#12B76A` |

`bg` is the tint behind the row, `solid` the 4px rail down its left edge, `ink`
text that has to sit on the tint and clears 4.5:1 against it.

**The colours live in `config/tasks.js` and come down on every row as
`row.accent`, and on `GET /tasks/meta` as `priorityColors`.** Hard-coding four
hexes in the web bundle and four more in the app is how a red in one place
becomes a slightly different red in the other, and nobody notices until somebody
puts the two screens side by side.

### Why `High` became `Urgent`, and not the other way round

The live data had already drifted there on its own: of 59 tasks, **fifty**
carried a priority of `Urgent` that no picker offered and no filter matched,
left behind by an earlier rework that renamed the level without migrating the
rows. `Urgent` is the word the company is already using.

### The collision this creates, and how it is resolved

`utils/taskLifecycle.js` has said since 2026-09-21 that **red is reserved for
overdue, which is not a status**. An Urgent row is now red. So:

- the **row** is tinted by priority (or green when done)
- the **status chip** keeps its own vocabulary — amber not started, blue in
  hand, violet in review, green done, grey called off
- **overdue** is a **solid** red chip (white on `bg-red-600`) plus a red
  deadline. Solid, so it still separates from an Urgent row's pale red tint

A late Low-priority task therefore still reads as low priority. Being late does
not promote it.

### …and on the clients

```
frontend/src/pages/Tasks.jsx              the page: tabs, stat tiles, List/Board
frontend/src/pages/TaskDetail.jsx         a thin shell around the detail body
frontend/src/utils/taskLifecycle.js       the shared web vocabulary
frontend/src/components/task/
  taskColors.js        ONE accentFor(task) — prefers the server's `accent`
  TaskStatTiles.jsx    the five clickable counters
  TaskRow.jsx          one list row, tinted, with its serial
  TaskBoard.jsx        the four columns
  TaskCard.jsx         one board card
  TaskDetailBody.jsx   the detail, page- and modal-safe
  TaskModal.jsx        the modal shell
  SplitTaskModal.jsx   pieces + the point distribution
  ChildTaskList.jsx    the pieces under a parent
  ExtensionModal.jsx   asking for more time
  PeoplePicker.jsx     team first, everybody by search
  …AssignTaskModal, TaskChips, TaskFilters, TaskUpdateModal, VoiceNote,
   CategoryManager, TaskTemplates, TaskDashboard

mobile/src/api/tasks.js                   every call, one file
mobile/src/utils/taskStatus.js            the shared app vocabulary
mobile/src/screens/TasksScreen.js         tiles + list + sort sheet
mobile/src/screens/TaskDetailScreen.js    the can-driven buttons
mobile/src/screens/AssignTaskScreen.js    the form
mobile/src/components/…                   the update, split and extension sheets
```

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

## 3a. Every person dropdown: your team first, everybody by search

The brief: *"anyone can create task but only assign from there branch (team)
only top to bottom only, and by searching we can find other people too … for all
dropdown like this only show the team member for manager and for CEO and MD show
Manager who are under them"*.

So the reporting tree is now walked **both ways**. `taskAccess.buildTree()`
fills `managerOf` and `reportsOf` from ONE scan (inverting afterwards would mean
a second pass over the same rows), and `teamOf(userId)` returns
`{ direct, indirect }` breadth-first — the order you would read an org chart.

`GET /tasks/meta` then tags every person with where they stand:

| `relation` | means |
|---|---|
| `direct` | reports to me |
| `indirect` | reports to somebody who reports to me |
| `manager` | I report to them |
| `chain` | above my manager |
| `peer` | everybody else |

**The rule every picker follows:**

1. With an empty search box — **my team only**: `direct` under "My team", then
   `indirect` under "Their teams".
2. With nothing at all to show — **my manager**, so an employee with no reports
   still sees the one person they would normally send something to.
3. **Typing searches the whole company**, with out-of-team matches under
   "Everyone else". The footer always says so.
4. Somebody who may only be ASKED stays visible, greyed, labelled "ask only".
   Hiding them produces the worst question a picker can produce — *"why is my
   manager not in this list?"* — and the answer, that work does not travel
   upward, is what the label says in three words. Picking one turns the form
   into a request.

### The CEO/MD fallback

A CEO or MD almost never appears in `EmployeeProfile.reportingManager` — they
have no employee profile at all in this portal, the same absence the
celebrations module had to solve. So the tree hands them an empty team, and a
picker that opens empty for the two people who assign the most work is the
picker not working.

When the tree gives a top-of-tree account nobody, everyone whose role is
`Manager` / `HRManager` / `AccountsManager` is shown as `direct`. It only ever
**widens the first screen** of a dropdown; it changes nothing about who may be
assigned, which stays `directionOf`'s answer and is enforced on write either
way.

### Why this is an annotation and not a search endpoint

The form already downloads the company's people in one call — that call exists
precisely because the form used to open with five requests in flight, and on a
phone against Android's five-connections-per-host that was the difference
between instant and a second and a half. A round trip per keystroke would put it
straight back. This company is fifty people.

If the directory ever outgrows one payload, this becomes
`GET /api/tasks/people?q=` with the same three fields and nothing else changes.

---

## 4. The lifecycle

```
PENDING ──start──> IN_PROGRESS ──submit──> SUBMITTED ──approve──> COMPLETED
   │                     ▲                      │
   │                     └─────send back────────┘
   └──cancel──> CANCELLED              (the assigner calls it off)
```

Four working states. The board's four columns are these four in order: **To
do · In progress · Review · Done**.

Everything else a list says is **derived**, never stored — a stored value goes
stale the moment a clock ticks past it:

| shown as | is really |
|---|---|
| **Overdue** | open, past its due date, **and not submitted** |
| **In time** | completed, `completedLate === false` |
| **Delayed** | completed, `completedLate === true` |
| **Declined** | *everybody* still on it has refused |
| **Not yet accepted** | somebody is sitting on an unanswered handover |

**A submitted task is not overdue.** The doer handed it in; how long the tray
takes afterwards is the assigner's business, and painting it red in the doer's
list would blame them for somebody else's inbox. The **In review** counter is
where that queue shows up instead. `config/tasks.isOverdue` and the controller's
`countersFor` aggregation both say so, and they have to agree.

`completedLate` is **frozen** on the assignee row — and as of 2026-09-22 it is
frozen at the moment they **hand it in**, not the moment it is approved. A
submission that landed on the Friday must not become "Delayed" because the
manager got to the review on the Monday. Extending a deadline afterwards must
not turn a late delivery into a punctual one either; that was already true and
still is.

### The review step — one state, and how to skip it

`Task.requiresApproval` (default **true**) decides whether a doer's Complete is
a completion or a submission. The redirect happens in ONE function,
`config/tasks.effectiveTarget`, applied once at the top of `taskEngine.move`:

| who presses Complete | `requiresApproval` | lands on |
|---|---|---|
| a doer | true | `SUBMITTED` |
| a doer | false | `COMPLETED` |
| a doer who is ALSO the person who set it | either | `COMPLETED` |
| the assigner | either | `COMPLETED` |
| anybody, on a REQUEST | — | `COMPLETED` |

It **redirects rather than refuses**, deliberately. An Android build that
predates this change still sends `COMPLETED`, and a 400 would look like a bug to
somebody who had just done the work. The response carries `coerced: true` so a
current client can say "sent for review" instead of "completed".

`capabilitiesFor` runs every transition through the same function and
de-duplicates, so the button a person presses and the thing that happens cannot
come apart.

### Approving is a verdict on the TASK, not on one row

A move normally lands on the mover's own assignee row. An assigner's answer to a
submission is the exception: approving lands on everybody who handed in, and
sending it back reopens for everybody who did. A per-row approve would leave a
five-person task half in review for ever, with the manager pressing Approve five
times to say one thing. (`taskEngine.move`, the `verdict` flag.)

Sending back **keeps the same people on it** and increments `rejectionCount`.
The brief says "reopen again and assign them again"; throwing the assignees away
and re-picking them would discard every remark, file and hour already on the row.

### 4e. Who signs it off — the approval moves with the work

`Task.approver`, added 2026-09-22 (fourth pass), for one sentence of the brief:
*"for delegate who is doing delegate he should be the approvar for that chain"*.

It defaults to whoever set the task. **Delegating moves it to the delegator**,
and each hop moves it again: whoever handed the work to you is the person you
answer to. A CEO who hands a manager a report did not ask to read the junior's
draft — they asked the manager for a report.

It is a field of its own rather than a rewrite of `createdBy`, because
`createdBy` is also "who set this", which the delegator did not do and which the
feed, the Delegated tab and the audit trail all still need to be true. Both
count as an assigner for permissions (`taskAccess.actorRoleOn`); only the
approver is notified when something lands in the tray.

**A piece is approved by the manager who split the task**, because splitting
makes them `createdBy` on each piece. Nothing extra was needed for that; it
falls out of §4b.

The Delegated tab and the "all" visibility scope both match on `approver` as
well as `createdBy`, so a manager who delegated somebody else's task still finds
it on their own desk.

### 4f. Transfer — it went to the wrong person

`POST /:id/transfer { to, reason }`, both required. Added 2026-09-22: *"if the
task is assigned to wrong user then they can transfer to anyone and it will be
fully transferred to the new user"*.

**It is the opposite of delegate, and the two must never be confused:**

| | delegate | transfer |
|---|---|---|
| who ends up answerable | **me** — I become the approver | nothing moves; it was never mine |
| do I still hear about it | yes, every update | **no, never again** |
| the direction rule | applies | **does not** — a mistake can point any way |
| the progress so far | kept | **reset** — they did not do it |
| the trail | `delegations[]` | `transfers[]` |

Three consequences of "fully transferred", each deliberate:

1. **The direction rule does not apply.** It is the one operation in the module
   allowed to go anywhere. Refusing to correct an upward mis-assignment would
   leave the wrong person holding it for ever. The company wall still applies.
2. **`originalAssignees` IS rewritten** — the only place in the module that
   rewrites it. It drives notifications, and leaving a mis-assigned person on
   every future update of a task that was never theirs is how people learn to
   ignore the bell. The history is not lost; it moves to `transfers`, which is
   append-only.
3. **The work starts again from the top.** The new person gets PENDING and
   AWAITING; any progress, submission or start time stays behind. They did not
   do that work and must not inherit it.

Points already CREDITED are never touched: somebody was paid for what they did
before the mistake was noticed, and clawing that back silently is how a payslip
stops reconciling.

Whoever set it and whoever it is on may both transfer it — they are the two
people who can see the mistake.

### Acceptance is a SECOND AXIS, not another status

Added 2026-09-21 (second pass). It would have been easy to make this
`ASSIGNED → ACCEPTED → IN_PROGRESS`, and that is exactly what the twelve-status
version did on its way to twelve. They answer different questions:

| | question |
|---|---|
| `status` | how far along the **work** is |
| `acceptance` | whether the **person** has agreed to do it |

They move independently. Somebody can **start without ever pressing Accept** —
common, and it must stay legal: chasing an acknowledgement for work that is
already done is the ceremony this module exists to remove. Starting or
completing therefore sets acceptance implicitly.

**…and since 2026-09-22 it goes the other way too: ACCEPTING STARTS THE WORK.**
The brief describes the board in one sentence — *"in todo all the assigned task
will come, after accepting that it will come to in progress"* — so taking a job
on moves it out of To Do, and there is no separate Start button to draw beside
Accept.

That does not collapse the two axes. A refusal still has nowhere else to live,
and "Accepted, and also press Start" is a distinction the person pressing it
does not have and should not be taught. What is left is: `status` says where the
work is, `acceptance` says whether anybody ever answered the handover — which is
still the only thing that can tell "nobody has looked at this" from "somebody
looked at it and said no".

| acceptance | meaning |
|---|---|
| `AWAITING` | handed over, not answered |
| `ACCEPTED` | taken on |
| `REJECTED` | refused, **with a reason** (the server requires one) |

Two more DERIVED states fall out of it, neither of them stored:

- **Not yet accepted** — somebody is sitting on an unanswered handover
- **Declined** — *everybody* still on it has refused. The work is owed and
  nobody is doing it, which is not any of the four statuses. The assigner has
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

### 4b. Pieces — a subtask is a task now

`Task.parentTask`. The embedded `subtasks` array is **gone** — there were zero
of them in the live data when this landed, which is why it was removed outright
rather than deprecated.

A piece carries everything a task carries: its own points, deadline, priority,
progress, acceptance, submission, feed and code. It appears in its owner's own
list. It can itself be split, to a depth of `MAX_SPLIT_DEPTH` (3 — a plan; 4 is
a maze). Capped at 50 per parent: past that the right answer is two tasks, and
it is also what stops a loop in a client turning one POST into a thousand rows.

| | who does it |
|---|---|
| **named** (`assignees` set) | that person. It is simply their task. |
| **open** (`assignees` empty) | **anybody in `openTo`** — the brief's *"they can pick the task"*. First to `POST /:id/claim` gets it. |

`openTo` is an explicit list, not "anybody on the parent". The parent is usually
on ONE person — the manager doing the splitting — so "anybody on the parent"
would offer the piece to nobody at all. It defaults to the splitter's own direct
reports (`taskAccess.defaultOpenTo`).

**The claim is a conditional update** (`assignees: { $size: 0 }`), so two people
tapping Claim in the same second cannot both get it; the second is told somebody
was quicker rather than silently overwriting the first. Picking something up
also **counts as accepting it** — asking somebody to press Accept straight after
they volunteered is the ceremony this module exists to remove.

**Visibility.** A piece is visible to its assignee, its creator, everybody in
`openTo`, and anyone with `tasks.manage`. Anyone who can see the **parent** can
also open a piece through it (`taskAccess.canSeeThroughParent` — one extra read
on exactly the requests that need it). So the CEO who set the parent sees the
manager's whole breakdown on the detail page, without the five pieces cluttering
their own list.

**The direction rule applies to every piece.** Handing a piece upward is refused
by name rather than quietly turned into a request — a "piece" that scores nobody
is not what the splitter asked for.

**The parent's counters are derived, never typed.**
`taskEngine.recomputeParent` is the only thing that writes `childCount`,
`childDoneCount`, `distributedPoints` and the parent's `progress`, and every
path that touches a child calls it. It is one query over the children rather
than a `$lookup` on every list row — which at fifty rows a page is fifty joins
to draw one line of text.

Finishing every piece does **not** auto-complete the parent. The progress bar
reads 100%; the person decides.

#### Which lists show the pieces

Without a rule, every list would show the parent AND its five pieces, and a
manager who split one job into five would see six rows for one job. So:

| tab | default |
|---|---|
| **My Tasks** (`scope=mine`) | pieces **included** — a piece IS the work I was given, and hiding it would hide my day |
| everywhere else | pieces **hidden** — they belong under the task they came from, which is where the detail page shows them |

`?includeSubtasks=0|1` flips it either way.

#### The old endpoints still work

An APK in somebody's pocket does not update because the server deployed. So
`POST /:id/subtasks`, `PATCH /:id/subtasks/:subId` and
`DELETE /:id/subtasks/:subId` survive as **adapters onto child tasks**, and
`GET /:id` still serialises a derived `subtasks` array from the children in the
old `{ _id, title, assignee, assigneeName, done }` shape. `:subId` is a child
task's id now; an old client only ever round-trips the id it was given, so it
cannot tell.

### 4c. Progress

A declared 0–100 on each person's row (`assignees[].progress`), rolled up to
`Task.progress`. **Declared, never inferred** — nothing in this module can tell
how much of a job is left, and a bar computed from elapsed time against the
deadline is a lie that looks like data.

| the row | what `progress` is |
|---|---|
| a task with **no pieces** | the mean of its live assignee rows; a `COMPLETED` or `SUBMITTED` row counts 100 |
| a task **with pieces** | the **points-weighted** mean of the pieces **plus the splitter's own share** |

The weighting matters. A manager who split 100 points as 60-to-the-team /
40-kept is 40% of the job themselves, so a parent showing 100% while its owner
has not started is a bar that lies. When nothing carries points, every part
weighs the same.

The model's roll-up hook deliberately **leaves a parent's figure alone**
(`if (!this.childCount)`). Only `recomputeParent` can see the children, and
overwriting from the assignee rows — which on a fully delegated task are one
person sitting at 0 — would reset a 70%-done job to zero on every save.

**Moving off zero starts the task.** Reporting 40% of a job that is still
"Pending" is not a state worth having, and making people press Start first is
the sort of second click that stops the first one happening at all.

### 4d. Asking for more time

`Task.extensions[]`, append-only. The doer's third answer, after accept and
decline.

It is **not a status**: the work carries on while the answer is awaited, which
is the entire difference between asking for more time and downing tools.

- a reason is **required** — "more time please" is not a case
- the new date must be **later** than the current deadline
- **one un-answered request per person**; somebody who could stack three would
  be asking the same question three times, and the assigner would have to refuse
  all of them to refuse one
- `fromDate` snapshots the deadline **at the moment of asking**, so a row three
  extensions deep can still say what was being extended
- approving moves `dueDate`, bumps `extensionCount`, and **clears
  `firedReminders`** — without that, a task extended past its last reminder
  would never be chased again
- neither answer touches anybody's frozen `completedLate`

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

A piece is a `Task`. An extension request is an embedded row on the task it
extends. Neither has a collection of its own, and neither should get one.

### The 2026-09-22 fields

On the task:

| field | what it is |
|---|---|
| `parentTask`, `parentCode`, `parentTitle`, `depth` | which task this is a piece of; the last two are snapshots so a row reads without a join |
| `openTo[]` | who may claim an unclaimed piece |
| `childCount`, `childDoneCount`, `distributedPoints` | the pieces, as counters. Written **only** by `recomputeParent` |
| `progress` | 0–100, rolled up (§4c) |
| `requiresApproval`, `submittedAt`, `rejectionCount` | the review step (§4) |
| `extensions[]` | every request for more time, and what was said (§4d) |
| `approver`, `approverName` | who signs it off — the delegator, after a delegation (§4e) |
| `transfers[]` | the trail of a mis-assignment being corrected (§4f) |

On each assignee row: `progress`, `progressAt`, `submittedAt`.

### Indexes

```
{ assignedTo: 1, status: 1, dueDate: 1 }        "my open tasks, soonest first"
{ 'assignees.user': 1, status: 1, dueDate: 1 }  the same for a co-assignee
{ createdBy: 1, status: 1, dueDate: 1 }         "what I delegated"
{ company: 1, kind: 1, status: 1, dueDate: 1 }  every walled admin list
{ status: 1, dueDate: 1 }                       the overdue sweep
{ loopUsers: 1, status: 1 }                     "tasks I am kept in loop on"
{ parentTask: 1, status: 1 }                    "the pieces of this task"
{ openTo: 1, status: 1 }                        "pieces offered to me"
{ recurringTask: 1, occurrenceKey: 1 }          UNIQUE, sparse — see §8
```

The `{ 'subtasks.assignee': 1 }` index went with the embedded array.

---

## 6. Points

**Every task is worth 100 points unless the assigner says otherwise.** One
figure, earned by EACH person on it — no split arithmetic across CO-ASSIGNEES. A
four-way split between four people on the same task is typing 25.
*(User decision, 2026-09-21.)*

The default lives in `Setting.tasks.defaultPoints`.

### Once it is split, that figure is a POOL (2026-09-22)

The brief: *"if manager is delegating any task as subtask to team member they
can do the point distribution to those task, by default it will be divided
equally"*. So splitting a task does not mint new points — it hands out the ones
it already had:

```
each person on THIS task earns    points − distributedPoints
each person on a PIECE earns      that piece's own points
```

A manager who splits 100 points three ways keeps nothing, which is the default
and is honest: they did not do the work. One who hands out 60 keeps 40 for
holding it together, and the split form says so live while they type.

**The pool can never be overdrawn**, on any code path. The engine refuses it
with a sentence a person can act on; the model clamps it as a backstop; and
`PATCH /:id` refuses to drop a task's points below what is already shared out.
Three guards for one rule because points settle in rupees and "subtasks" would
otherwise be a money printer with a + button.

`taskEngine.shareOut` does the arithmetic and the pool comes out **whole**: 100
over three is **34 / 33 / 33**, not 33/33/33 with a point quietly evaporating.
Anything the splitter typed is honoured exactly; only the rest is shared, and
only out of what is left after the explicit figures are taken off.

`taskPoints.award` reads `task.effectivePoints()`, not `task.points`. Reading
the raw figure there would pay the pool out TWICE — once to the pieces and once
again to the parent, which on a three-way split is 200 points of real money for
100 points of work.

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

## 11a. The board

`GET /api/tasks/board` takes every filter the list takes and returns the four
columns of §4 in order, each with its own `count`, its own capped page of rows
and a `more` figure.

**The page shows TWO of them, stacked** — the shape the user drew:

```
Assigned to me   [ To Do ] [ In Progress ] [ Review ] [ Done ]   scope=mine
Assigned by me   [ To Do ] [ In Progress ] [ Review ] [ Done ]   scope=delegated
```

Two calls to the same endpoint with different `scope`, rather than a bespoke
"my two boards" route: the filter, the sort, the counters and the row shape are
already identical, and a second endpoint would be a second place for them to
drift.

It is **four capped queries, not one big one grouped in the browser**: a single
200-row page sorted by deadline can easily be 200 pending tasks, leaving "In
review" — the column somebody opened the board to clear — looking empty.

**Dragging a card does not move it.** The server refuses a silent status change
(see "Every move says something out loud"), so a drop opens the update box
pre-set to the target status. That is the rule holding, not an oversight, and
the web component says so in a comment.

---

## 11b. Serials and sorting

`row.serial` is 1-based and **continues across pages** — row 51 is "51", not "1"
again. A number that restarts is not a serial, it is a row index, and quoting
"number 3" becomes ambiguous the moment anybody turns a page.

Six sorts (`?sort=&dir=`), from `config/tasks.SORTS`:

| key | means |
|---|---|
| `due` | soonest deadline first — the default |
| `assigned` | day it was handed over, newest first |
| `pending` | **how long it has been sitting there**: open work first, oldest first |
| `points` | what it is worth |
| `priority` | Urgent, then Medium, then Low |
| `title` / `created` | alphabetical, newest |

Two of them cannot be a plain `.sort()` and go through an aggregation
(`sortedRows`):

- **priority** — `Low < Medium < Urgent` alphabetically is exactly backwards, so
  the rank is computed first. The `$switch` also ranks the legacy `High` as
  Urgent, or the company's actual urgent work would sort into the middle of the
  list.
- **pending** — "how long has this been sitting there" must put OPEN work first
  regardless of age. A task finished last year is not pending for 400 days; it
  is not pending at all.

`_id` always breaks the tie, so paging cannot repeat or skip a row when fifty
tasks share a due date — which, on a portal where people set everything to 6pm,
they do.

---

## 12. Counters

Above every list, as five clickable stat tiles: **Total · Overdue · Pending ·
In review · Completed** (completed splitting into In time / Delayed on the
report).

**The boxes do not overlap.** Every task is counted in exactly one of Overdue /
Pending / In progress / In review / Completed / Cancelled, so they sum to the
total and the row can be trusted. Overdue wins over Pending and In progress — a
late task is late, and counting it in both makes the red figure meaningless and
the arithmetic wrong. **In review wins outright**: a submitted task is never
overdue (§4).

Counters and rows come from **ONE filter built once** (`buildQuery`). Built
separately they would drift, and a counter that disagrees with the rows beneath
it is worse than no counter.

### The sidebar badge

`taskApproval` on both portals. Since 2026-09-22 it counts **two** things: work
I have to do (mine, not yet handed in) **and** work I have to look at (somebody
handed in a task I set). A submission nobody has read is exactly as blocking as
a task nobody has started, and it is the one queue nobody else can clear for me.

A row I have *submitted* is deliberately not counted for me — it is out of my
hands, and counting it would leave a number I cannot make go down.

**The badge and the list must count the same rows.** On 2026-09-24 they did
not: 48 people wore a red 1 over an empty Tasks page. The badge counted every
row on them; the list asked for `kind: 'TASK'`, and the 57 "Documents
Submission" rows set on 2026-09-11 — before `kind` existed — have no `kind` at
all. A schema default is applied on hydration, never inside a query, so they
were missing from every list, board, tile and dashboard. Every filter now names
a kind through `config/tasks.kindFilter`, where TASK includes a missing one —
the same rule `spellingsOf` is for status words.

### The date chips — open work always shows on the ones that contain today

Today · Yesterday · This week · This month · Next week · All time · Custom.
They filter on the **deadline** — "this week" is the work due this week — but on
**Today, This week and This month** they narrow **finished** work only. Every
open task (pending, in progress, in review) shows whatever its deadline,
including none. *(User decision, 2026-09-24.)*

The page opens on This month and the badge counts every open task on you. With
a strict window, a task due last month and still undone, one due next month, or
one with no deadline put a red number on the pill over a page saying "Nothing
on your plate" — on 1 Oct that would have been all 48 people with a Documents
Submission task still open. Finished work stays filed under the period it was
due in.

Yesterday, Next week and Custom look up one period and stay strict. So does
the **dashboard** (`buildQuery(…, { strictRange: true })`): a score for "this
month" has to be over what was due this month, or a job due in December drags
September's figure down. It is a third argument rather than a query parameter,
so no client can switch it.

---

## 12a. The endpoints

```
GET    /api/tasks                         the list      (see §11b for sort)
GET    /api/tasks/board                   the four columns
GET    /api/tasks/counters                the tiles
GET    /api/tasks/meta                    the form's reference data
GET    /api/tasks/:id                     detail + children + updates + can
POST   /api/tasks                         set one
PATCH  /api/tasks/:id                     change one
DELETE /api/tasks/:id[?purge=1]           archive / SuperAdmin: for good

POST   /api/tasks/:id/status              { to, note, voiceNote?, files? }
POST   /api/tasks/:id/submit              hand it in
POST   /api/tasks/:id/approve             sign it off
POST   /api/tasks/:id/reject              send it back   { note }   ← required
PATCH  /api/tasks/:id/progress            { progress, note? }

POST   /api/tasks/:id/accept              take it on
POST   /api/tasks/:id/decline             refuse it      { reason }  ← required
POST   /api/tasks/:id/delegate            pass it on     { to, note }

POST   /api/tasks/:id/split               { items: [ … ] }  → { children }
POST   /api/tasks/:id/claim               take an open piece
POST   /api/tasks/:id/transfer            { to, reason }  ← both required
GET    /api/tasks/:id/children            the pieces

POST   /api/tasks/:id/extension           { toDate, reason }  ← both required
POST   /api/tasks/:id/extension/:reqId    { approve, note }

POST   /api/tasks/:id/subtasks            LEGACY → split
PATCH  /api/tasks/:id/subtasks/:childId   LEGACY → complete / reopen the child
DELETE /api/tasks/:id/subtasks/:childId   LEGACY → archive the child
```

`/submit`, `/approve` and `/reject` are the ONE status endpoint underneath. They
exist as their own routes for the **wording**: "Submit", "Approve" and "Send
back" are not "mark it in progress" however much they share a code path, and a
client that had to work out which move its button meant would be re-deriving the
server's review rule.

Accept, decline and delegate are still not status moves: accepting is an
acknowledgement, declining hands the problem back without cancelling anything,
and delegating changes *who* rather than *where*. All are gated by IDENTITY
inside the engine — only somebody actually on the task may use them, so an
assigner cannot accept on a doer's behalf.

**`can` comes down with every LIST row**, not just on the detail response. The
list draws Accept / Decline / Start / Submit / Approve / Send back / Claim
straight on the row and opens the same update box the detail page does, so it
needs the same answer to "what may this person do to this task". It is
in-memory work over at most 200 rows and no extra query — the alternative is the
client re-deriving the rules, which is the split-brain this module was rebuilt
to end.

`can` now carries: `canSubmit`, `canApprove`, `canReject`, `canWithdraw`,
`canSetProgress`, `myProgress`, `canSplit`, `canClaim`, `canTransfer`,
`pointsBudget`, `canRequestExtension`, `canDecideExtension` — alongside everything it carried
before. `canAddSubtasks` and `canTickSubtasks` are kept truthful for an
un-updated Android build; they drive child tasks now.

---

## 13. Migrating

```bash
npm run migrate:tasks            # report what it would do
npm run migrate:tasks:apply      # do it
```

`scripts/migrateTasksV4.js`. Idempotent; safe to re-run. It:

1. **maps every status** — the twelve of 2026-09-17 and the four before them.
   V4 does this as well as V3 because **V3 was never run against this
   database**: 49 rows were still `ASSIGNED` and one was still `Done` when V4
   landed. `UNDER_REVIEW` and `Review` now land on `SUBMITTED` rather than
   `IN_PROGRESS`.
2. **maps every priority** — `High` / `Critical` / `Highest` → `Urgent`,
   `Normal` → `Medium`, `Lowest` → `Low`
3. sets `requiresApproval` — true on a task, false on a request
4. sets `progress` — 100 on a completed row, 0 on everything else. Nothing is
   inferred from elapsed time
5. zeroes `childCount` / `childDoneCount` / `distributedPoints` / `depth` so a
   list can read them before anything has ever been split
6. reconstructs `completedLate` once, from `completedAt` against `dueDate`
7. **converts any embedded subtask into a real child task**, splitting the
   parent's points equally, then clears the array so a re-run cannot duplicate
   it. Expected to find nothing — there were zero in the live data — but a
   restored backup or another environment must not be silently emptied
8. seeds TaskCategory from the categories already in use
9. sets `kind` to TASK on any row with none — V3's step, repeated because V3
   never ran (57 rows on 2026-09-24)

The model's own hooks apply the same status AND priority maps, so a row the
migration has not reached is still a valid document and an un-updated Android
build still works. A missing `kind` reads as TASK in every filter
(`config/tasks.kindFilter`) and in every lean row (`decorate()`), so step 9 is
tidying, not a fix.

### What the live data looked like when this landed (2026-09-22)

59 tasks · 0 embedded subtasks · 4 feed rows · 1 category · 1 template · 0
recurring schedules · **0 task incentive credits**. Priorities in the wild:
`Urgent` 50, `High` 7, `Medium` 2. That census is why the embedded array could
be removed outright and why `High` maps to `Urgent` rather than the reverse.

---

## 14. Testing

```bash
npm run test:tasks      # 117 assertions, no database, about a second
npm run test:tasks:db   # end-to-end, needs TASK_TEST_MONGO_URI
```

`scripts/testTasks.js` is pure — no connection, no fixtures — and covers the
status vocabulary (all three generations), the transition table, overdue
derivation, reminder arithmetic, the recurrence calendar (including the 31st
clamping into February), the model's roll-up hooks, the acceptance axis, the
rule that a refusal must not hold the roll-up open, `originalAssignees` being
stamped once, and since 2026-09-22: the priority map, the colour rule, the
points pool and `shareOut`'s whole-number split, the review redirect and its
three exemptions, "submitted is not overdue", the four-state roll-up, and the
fact that a parent's progress bar is not overwritten by its own assignee rows.

`scripts/testTaskIntegration.js` proves the things that cross a document
boundary and a pure test therefore cannot: a split producing real child tasks
that shrink the parent's remainder, the pool being un-overdrawable, a piece
being claimable exactly once, the submit → send back → resubmit → approve round
trip keeping the work, punctuality frozen at submission, points-weighted
progress reaching the parent, an extension moving the deadline and re-arming the
reminders, and points crediting from the remainder rather than the pool.

It **refuses to run without `TASK_TEST_MONGO_URI`**, and refuses again if that
value matches `MONGO_URI` — this project's ordinary connection string points at
the live Atlas cluster and the script creates and deletes data. Point it at a
local mongod:

```bash
TASK_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_task_test" npm run test:tasks:db
```

**The model tests use `validate()`, not `validateSync()`.** Mongoose runs NO
middleware on validateSync — the pre-validate hooks that normalise a status and
roll the assignees up simply do not fire, and a test written against it passes a
document the application would never produce. This cost half an hour once.

---

## 15. Three package.json scripts were pointing at nothing

Found while wiring this up, and worth recording because the failure was silent:

| script | pointed at | exists? |
|---|---|---|
| `test:tasks` (a DUPLICATE key, so it won) | `scripts/testTaskEngine.js` | no |
| `test:tasks:db` | `scripts/testTaskWorkflow.js` | no |
| `migrate:tasks` | `scripts/migrateTasksV2.js` | no |

JSON takes the last of two identical keys, so `npm run test:tasks` had been
running a file that did not exist — and the 2026-09-21 rework's test suite had
therefore never been run through npm at all. All three now point at real files.
