# Task & Workflow Module

Reworked 2026-09-17, replacing the four-status task list the portal had before.

This is the module's map: what is where, why the shape is what it is, and the
handful of rules that are load-bearing enough to be worth writing down twice.

---

## 1. What it does

A task is a unit of work somebody is answerable for. The module covers the whole
life of one:

- **hand it over** — to one person or several, each with their own part,
  deadline, progress and submission
- **work on it** — accept or decline, start, a checklist, a clock, comments,
  files, subtasks, dependencies
- **hand it back** — a submission carrying whatever the task demands (remarks,
  a number of photos, an attachment, a signature, a position)
- **decide it** — approve, send back, or run it through a workflow of several
  approvals, some in parallel, some conditional
- **chase it** — reminders before the deadline, escalation up a ladder after it
- **repeat it** — templates, recurring schedules, and HRMS events that raise
  tasks by themselves
- **pay for it** — incentive points, into the pool the portal already has
- **account for it** — an immutable per-task trail, plus the portal-wide audit log

---

## 2. Architecture at a glance

```
config/taskWorkflow.js         the lifecycle: statuses, legal moves, who may make them
  │
services/taskEngine.js         THE ONLY WAY A STATUS MOVES
  ├── taskAccess.js            who may see / edit / review which tasks
  ├── taskWorkflow.js          the workflow runtime (sequential / parallel / conditional)
  ├── taskTemplates.js         a template → a task's fields
  ├── taskIncentive.js         outcome → points → IncentiveCredit
  ├── taskNotify.js            every notification the module sends
  ├── taskEvents.js            HRMS events → tasks
  ├── taskReminderWorker.js    deadlines, acceptance chasing, escalation, SLA
  └── taskRecurrenceWorker.js  recurring generation

controllers/
  taskController.js            the task: CRUD, lifecycle, assignees, handover, bulk
  taskWorkController.js        submissions, approvals, time, comments, extensions, files
  taskWorkflowController.js    workflows, templates, recurring schedules
  taskAnalyticsController.js   dashboards, workload, exports

routes/
  taskRoutes.js                /api/tasks
  taskWorkflowRoutes.js        /api/task-workflows
```

---

## 3. Data model

One document per task, with the unbounded things in their own collections.

| Collection | What it holds |
|---|---|
| **Task** | the work, its people, its requirements, and a **frozen copy** of the workflow it is running |
| **TaskSubmission** | one row per hand-back, per person, per attempt — never overwritten |
| **TaskTimeEntry** | one row per stretch of work; pauses are inside the row, not separate rows |
| **TaskActivity** | the immutable per-task trail. Append only; nothing updates or deletes a row |
| **TaskComment** | remarks, including reviewer-only internal notes |
| **TaskExtension** | a deadline request, keeping all three dates (was / asked for / granted) |
| **TaskIncentive** | what one person earned on one task, and the IncentiveCredit it became |
| **Workflow** | a draft plus append-only published versions |
| **TaskTemplate** | a task worth creating more than once, in relative terms |
| **RecurringTask** | a schedule; the tasks it makes are ordinary Tasks pointing back at it |

Embedded on Task (bounded, always read together): assignees, checklist,
`workflowSteps`, attachments, dependencies, custom fields, requirements,
location config, reminder policy, incentive config.

### Indexes

Declared in `models/Task.js`. The compounds that matter:

```
{ assignedTo: 1, status: 1, dueDate: 1 }   "my open tasks, soonest first"
{ 'assignees.user': 1, status: 1 }         the same for a non-primary assignee
{ pendingApprovers: 1, status: 1 }         the approval inbox — the hottest query
{ company: 1, status: 1, dueDate: 1 }      every walled admin list
{ status: 1, dueDate: 1 }                  the overdue sweep
{ recurringTask: 1, occurrenceKey: 1 }     UNIQUE, sparse — see §7
```

`TaskTimeEntry` carries a **partial unique index** on `{ user: 1 }` filtered to
`status ∈ {running, paused}`: one running timer per person, enforced by the
database rather than by a handler. `$in` in a `partialFilterExpression` needs
**MongoDB 6.0+**; production is on 8.0.

---

## 4. The lifecycle

Twelve states. The full transition table, including who may make each move and
which moves need a reason, is `config/taskWorkflow.js` — it is the single source
of truth and is mirrored (presentationally only) in
`frontend/src/utils/taskLifecycle.js` and `mobile/src/utils/taskStatus.js`.

```
ASSIGNED ─accept→ ACCEPTED ─start→ IN_PROGRESS ─submit→ SUBMITTED
   │                                    │                    │
   └─decline→ DECLINED                  ├→ BLOCKED           ├→ UNDER_REVIEW
                                        └→ ON_HOLD           │
                                                    ┌────────┴────────┐
                                              APPROVED           REJECTED
                                                    │                 │
                                              COMPLETED      ─→ IN_PROGRESS (resubmit)
```

`COMPLETED → IN_PROGRESS` exists but is **admin-only and needs a reason** — the
"authorized reopen action" rather than an editable field.

### The four promises `transition()` keeps

Every path — web, app, worker, workflow — goes through
`services/taskEngine.transition`, which is what makes these true rather than
intended:

1. **Only legal moves happen.** The table decides, not the caller.
2. **Two people cannot both win.** The write is one conditional update keyed on
   the status we believe the task is in. The second approver is told the task has
   already moved instead of overwriting a decision that has been notified.
3. **Nothing moves without a trail line.** Same function, same call.
4. **Timestamps are the server's.** A client may not send `completedAt`.

### The old vocabulary

`Todo / InProgress / Review / Done` are still accepted everywhere —
`normaliseStatus` converts them, a pre-validate hook converts them on save, and
`PATCH /api/tasks/me/:id/status` is kept as the compatibility route every Android
build in the field calls. See §11.

---

## 5. Permissions

**No second permission system** (spec §36). The spec's eighteen
`TASK_*` permissions map onto four things the portal already has:

| Spec | Here |
|---|---|
| `TASK_CREATE`, `TASK_EDIT`, `TASK_DELETE`, `TASK_ASSIGN`, `TASK_VIEW_ALL` | **`tasks.manage`** — existed before the rework |
| `TASK_MANAGE_WORKFLOW`, `TASK_MANAGE_TEMPLATE`, `TASK_MANAGE_SETTINGS` | **`tasks.workflow`** — the one new key |
| `TASK_APPROVE`, `TASK_REJECT`, `TASK_EXTEND`, `TASK_ESCALATE`, `TASK_VIEW_TEAM` | **identity** — you are the task's assignee, supervisor, manager, creator or a named approver. Nothing to grant |
| `TASK_VIEW_SELF` | the `/me` routes. Everybody |

`tasks.workflow` is its own key for the same reason `leaveHierarchy.manage` is
separate from `leave.manage`: running today's tasks is a day's work, and deciding
how every future task is routed is a standing decision. **An HR Manager does not
get it by being HR** — a Super Admin ticks it per account.

Sanctioning a task incentive needs `requireIncentiveCreditor` (HR, CEO, MD, Super
Admin, or a manager of every incentive) — **not** `tasks.manage`, because it puts
points into the company-wide pool.

The company wall (`utils/employeeScope`) applies unchanged, to lists, to
per-record reads, and to workflow actor resolution — a step addressed to "every
HR Manager" never reaches another company's HR.

---

## 6. The workflow engine

A workflow is a list of steps. Everything comes out of that one list:

- **sequential** — steps run in `order`
- **parallel** — steps sharing a `parallelGroup` open together; the group settles
  on its `join` rule (`all` / `any` / `majority`)
- **mixed** — a parallel group followed by an ordinary step
- **conditional** — a `condition` step tests a field of the task and names the
  step to jump to for true and for false

### Versioning, and why it holds

Three layers, and the one that actually holds is the third:

1. `draft` is freely edited and runs nothing.
2. Publishing appends an immutable `version`. Nothing updates or deletes one.
3. **Starting a task copies the version's steps onto the task**
   (`Task.workflowSteps`). A running task never reads the Workflow document
   again.

So a workflow can be edited, republished or deactivated with **no effect
whatsoever** on work already under way.

### Actors are resolved late

Who acts on a step is worked out when the step **opens**, not when the task
starts — a reporting line that changes mid-task is honoured, and a named
approver who has left does not hold up every task on the route. Once resolved
they are frozen onto the step.

A step nobody can be resolved to is **skipped and logged loudly** rather than
stalling the task forever. `POST /task-workflows/:id/simulate` answers "who would
actually be asked?" using the same resolver, so that is discoverable before
anybody's real work depends on it.

`validateSteps` refuses to publish a workflow that would strand a task: a
duplicate key, a branch to a step that does not exist, an approval with no
assignee rule, a wait with no duration, a parallel group whose members disagree
about how it finishes.

---

## 7. Background jobs

**No new scheduler.** Two workers join the six the app already runs, with the
same `startWorker()` convention, started from `server.js`.

### `taskReminderWorker` — every 5 minutes

Four passes: deadlines approaching, deadlines passed, tasks nobody accepted, and
workflow steps past their SLA (it also advances `wait` steps whose time is up).

**It cannot replay.** Every notification is keyed (`due:24`, `over:2:supervisor`,
`accept:assignee`, `step:hr:1`) and the key is written onto
`Task.firedReminders` in the **same conditional update** that decides to send it
(`claim()`). A restart, a second API instance or a clock stepping backwards
cannot fire the same reminder twice — the trap the push-reminder worker hit once
already.

Default ladder (a task, template or workflow step may override it):

```
before due   24h, 4h, 1h, 15m   → the assignee
after due    15m, 1h            → the assignee
             2h                 → the supervisor
             24h                → the manager
             48h                → the tasks.manage bench   (CRITICAL)
```

#### The backlog rule

**A task that is more than 48 hours overdue and has never had a single overdue
reminder fired is adopted quietly**: every rung it has already passed is claimed
without sending anything, and it is chased normally from there if it slips
further. The same applies to a task handed over days ago and never accepted.

This is not a nicety. On the day this module ships there are 51 open tasks
carried over from before the rework, all past their deadline — and without this
rule the worker's first tick would fire a wave of "overdue!" notifications and
pushes at 51 people about work from last week, all at once. It is the same class
of mistake the push-reminder worker made when a restart replayed a day of pushes.

The discriminator is safe even after a long outage: a task that goes overdue
while the worker **is** running has its first rung claimed within five minutes,
so it can never look like backlog. Tune with `TASK_REMINDER_BACKLOG_HOURS`.

### `taskRecurrenceWorker` — every 15 minutes

Generates due instances from `RecurringTask`. **It cannot mint the same day
twice**: each generated task carries `occurrenceKey` (the IST day it is FOR) and
`Task` has a unique index on `(recurringTask, occurrenceKey)`. Idempotence lives
in the schema, not in a careful function.

It also **catches up** — a worker that was down for a week makes the instances it
missed, capped at 10 per schedule per tick.

---

## 8. Incentives — points, not rupees

The spec's §25 is written in rupees (₹500 base, ₹200 if a day late). This portal
pays **every** incentive in one company-wide points pool valued by a single rate
(`Setting.incentive.rupeePerPoint`), so a rupee figure on a task would be a
second answer to "what is this person owed", sitting beside the first and
reconciled by nobody.

**The manager who assigns the task sets what it is worth, in points.** The ladder
is expressed as a share of that figure, so the spec's numbers are exact:

| Outcome | Share | 500 points |
|---|---|---|
| Completed early | 1.0 | 500 |
| Completed on time | 0.8 | 400 |
| Up to a day late | 0.4 | 200 |
| More than a day late | 0 | 0 |
| Sent back before approval | 0.5 | 250 |

Being **sent back outranks punctuality** — a task rejected and then fixed by the
deadline is not the same as one right the first time.

The sequence, and each arrow is a different person:

```
task approved → evaluated as Pending (TaskIncentive)
              → sanctioned by somebody who may credit the pool
              → IncentiveCredit written → status Credited
```

From that moment the points are indistinguishable from any other points: the same
roll-ups add them, the same rate values them, the same Points Dashboard pays
them. **Nothing in this module writes to Payroll.**

---

## The calendar is the portal's, not the module's

**The Tasks page has no calendar tab and the module exposes no calendar
endpoint** (user decision, 2026-09-17). Task deadlines appear on the ONE calendar
the portal already has — `frontend/src/pages/Calendar.jsx`, mounted in both
portals, fed by `GET /celebrations/calendar`, where `task` is an entry type
beside holidays, festivals, company events, birthdays, interviews and reminders.

A month grid inside the Tasks page would have been a second place to look for the
same answer, and the two would have drifted. What the rework changed there
instead, in `celebrationsController`:

- the query now matches `assignees.user` as well as `assignedTo`, so a
  contributor who is not the primary assignee still sees the deadline;
- archived tasks are excluded;
- `done` is *terminal*, not just completed — a cancelled task is not still owed;
- the tile carries the `TSK-` code, the human `statusLabel` and an `overdue` flag;
- the detail panel has an **Open task** button, pathed from the URL so a link
  never switches which portal you are in.

The Tasks page keeps a **Calendar** button in its header pointing there, so the
way across is signposted rather than merely absent.

---

## 9. Location & geofencing

Two independent settings, both per task, both off by default:

- `location.captureOn: ['accept','start','submit','approve','complete']` — record
  a position at these moments
- `location.enforceOn: ['start','submit','complete']` — **refuse** the act unless
  the person is inside the fence

The fence is the task's named `WorkLocation`, or the assignee's own assigned site
(`EmployeeProfile.workLocationRef`) — the same question attendance already
answers. Distance is Haversine (`utils/geo`), and `distanceM` / `insideFence` are
**frozen at capture time**: the site's pin or radius may be edited later, and the
record has to keep saying what was true.

There is no continuous or background tracking anywhere in the module, and both
clients show visibly when a position is being taken.

---

## 10. API

### `/api/tasks`

Three tiers, in route order — which is the permission model.

**Self-service** (no capability): `GET /me`, `/me/summary`, `/me/timer`,
`/me/timesheet`, `/approvals`, `/meta`, `/board`

**Administration** (literal paths, before `/:id`): `GET /incentives`,
`PATCH /incentives/:id`, `PATCH /time-entries/:id`, `PATCH /extensions/:id`,
`POST /bulk`, `GET /analytics`, `/workload`, `/export`, `/export/timesheet`

**The list and one task**:

```
GET    /                      list (filters, search, paging — all server-side)
POST   /                      create                            tasks.manage
GET    /:id                   the whole detail page in one call
PATCH  /:id   PUT /:id        update                            identity
DELETE /:id                   archive; ?hard=true deletes       identity

POST   /:id/status            any move the caller may make
POST   /:id/accept            /decline  /start
POST   /:id/submit            multipart, up to 10 × 25 MB
POST   /:id/review  /approve  /reject
POST   /:id/steps/:key/decide one step of a parallel group

PATCH  /:id/checklist/:itemId          /:id/progress
POST   /:id/assignees   DELETE /:id/assignees/:userId   POST /:id/handover
POST   /:id/timer/start  /:id/timer/:action  /:id/time-entry   GET /:id/timesheet
GET    /:id/comments    POST /:id/comments
POST   /:id/extensions
POST   /:id/attachments  GET /:id/files/:fileId
GET    /:id/activity

PATCH  /me/:id/status         COMPATIBILITY — the pre-rework shape (§11)
```

### `/api/task-workflows` — all behind `tasks.workflow`

```
GET/POST /                GET/PATCH/DELETE /:id
POST /:id/publish         POST /:id/simulate
GET/POST /templates       GET/PATCH/DELETE /templates/:id   POST /templates/:id/preview
GET/POST /recurring       PATCH/DELETE /recurring/:id       POST /recurring/:id/run
```

Reading `/templates` and the workflow list also accepts `tasks.manage`, because
choosing a template is part of creating a task.

---

## 11. Compatibility with what was already there

The rework is **additive on the same collection with the same `_id`s**. 57 live
tasks were on it, 51 of them an open "Documents Submission" handed to the whole
company on 11 September 2026.

- `title`, `description`, `project`, `assignedTo`, `priority`, `dueDate` and
  `createdBy` all mean exactly what they used to.
- Every new field has a default, so an un-migrated row is a valid document.
- `assignedTo` is kept as the **primary assignee** and maintained by the model
  from `assignees[]` — it is what every legacy query, the company wall and the
  Android app read.
- The four old status words are still valid values and are normalised on read and
  on save.
- `PATCH /api/tasks/me/:id/status` is kept deliberately. It is what every Android
  build **at or below 2.8.24** calls; it routes into the same state machine, so an
  old client gets the **new** rules rather than the old ones.

### The app

Ported in **2.8.25**. `mobile/src/api/tasks.js` mirrors the web's API module
function for function — the one difference is that React Native's FormData takes
`{uri, name, type}`, so every multipart call goes through `utils/filePart` and
sets the boundary header explicitly.

`mobile/src/screens/TaskDetailScreen.js` is the web's TaskDetail as a phone
screen, and draws its buttons from the same `can` / `transitions` the server
returns rather than re-deriving the rules. Before it existed the app could only
flip a status, so every task requiring a photo, a location or a signature was
refused with a sentence telling the person to find a computer — for work usually
done nowhere near one.

NOT ported, deliberately: the workflow, template and recurring-schedule
**builder** (the web's AdminTaskWorkflows). Designing how every future task is
routed is a desk job with a lot of structure on screen at once; the app runs the
routes, it does not draw them.

### Migration

```bash
node scripts/migrateTasksV2.js            # report only — writes nothing
node scripts/migrateTasksV2.js --apply    # migrate
```

Idempotent, additive, nothing overwritten that already has a value. It converts
statuses, builds an assignee row from `assignedTo`, mints `TSK-` codes, stamps
company/department/supervisor and preserves the original due date.

---

## 12. Setup

Nothing new to configure. **No new environment variables**, no new dependencies
on either side — it uses the mongoose, exceljs, multer, GridFS, Firebase-push and
React/Tailwind/axios that were already there.

Seed the starting templates and workflows (optional, but the HRMS event hooks do
nothing until at least one template is wired):

```bash
node scripts/seedTaskTemplates.js            # report only
node scripts/seedTaskTemplates.js --apply
```

Grant `tasks.workflow` to whoever should design routes — Permissions page,
Work Management group.

---

## 13. HRMS events

`services/taskEvents.js`. An event does **not** describe work; it names a
trigger, and whatever active templates carry that trigger produce the tasks. HR
changes what happens on a new joiner by editing a template, not by asking for a
code change.

| Trigger | Raised from |
|---|---|
| `employee.created` | `employeeController.createEmployee` |
| `employee.confirmed` | `lifecycleController` (on `confirm` only) |
| `employee.promoted` | `payrollController.giveHike` |
| `employee.transferred` | available; no hook wired yet |
| `exit.approved` | `exitController`, when a resignation enters the notice period |
| `exit.completed` | available; no hook wired yet |

Every hook is **fire-and-forget and error-swallowing**. A resignation must be
accepted even if the exit tasks cannot be made. Each is guarded by an
`occurrenceKey` of `<trigger>:<subject>:<template>`, so a retried request cannot
produce two onboarding plans for one person.

---

## 14. Testing

```bash
npm run test:tasks        # 104 checks, no database, ~1 second
npm run test:tasks:db     # end-to-end, needs a throwaway database
```

`scripts/testTaskEngine.js` covers the pure rules: the status vocabulary, the
transition table, submission requirements, workflow conditions, parallel joins,
publish validation, recurrence arithmetic (including the short-month rule),
incentive outcomes and shares, derived progress, and time arithmetic with pauses.

`scripts/testTaskWorkflow.js` covers what needs a database: the lifecycle
running, illegal moves refused, **two approvers not both winning**, rejection
preserving history, sequential / parallel / conditional workflows advancing,
dependencies, geofencing, the one-timer index, the incentive staying pending, and
the reminder claim. It **refuses to run** unless `TASK_TEST_MONGO_URI` names a
throwaway database different from `MONGO_URI`:

```bash
TASK_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_task_test" npm run test:tasks:db
```

`frontend/task-sandbox.html` renders the real pages against fixtures with no
database at all (`npm run dev`, then `/task-sandbox.html`). Delete it and
`src/task-sandbox.jsx` when they stop being useful — they are dev-only and are not
in the production bundle.

---

## 15. Deployment notes

- Two more `setInterval` workers per API instance. Both are idempotent, so
  running several instances is safe; they will simply do less each.
- The reminder worker scans open tasks with a deadline inside 25 hours, capped at
  2000 per tick and served by `{ status: 1, dueDate: 1 }`.
- Evidence goes to **GridFS on the same Atlas cluster** as everything else. 25 MB
  per file, 10 files per submission: a site inspection with video will grow the
  cluster faster than the rest of the portal does. Watch it.
- `partialFilterExpression` with `$in` needs **MongoDB 6.0+** for the one-timer
  index. Production is 8.0.32.
- `frontend/task-sandbox.html` is not a build entry (`build.rollupOptions.input`
  is the default `index.html`), so it never ships.

---

## 16. Not built

Deliberately, and each for a stated reason:

- **QR / barcode scanning** (§33) — the asset module has no QR infrastructure to
  reuse yet, and inventing one belongs with assets rather than with tasks.
- **Offline queueing** (§34) — the spec itself says not to build it without a
  clear need. The app is online-first everywhere else in this portal.
- **AI features** (§48) — explicitly an optional later phase, and explicitly not
  a dependency of the core.
- **The full mobile port** — the two existing screens were brought onto the new
  vocabulary and keep working (list, accept/start/submit via the compatibility
  route). Evidence, geofencing, the timer, approvals and the workflow rail are a
  follow-on pass.
- **A drag-and-drop workflow canvas** — the structured builder does the same job
  with no new dependency and works on a phone.
