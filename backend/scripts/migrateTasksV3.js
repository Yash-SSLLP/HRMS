/**
 * Bring the task module's live data onto the 2026-09-21 shape.
 *
 *   node scripts/migrateTasksV3.js          # report what it would do
 *   node scripts/migrateTasksV3.js --apply  # actually do it
 *
 * WHAT CHANGED, AND WHAT THIS HAS TO DO ABOUT IT.
 *
 * 1. TWELVE STATUSES BECAME THREE. Everything that meant "not done yet" —
 *    ACCEPTED, SUBMITTED, UNDER_REVIEW, REJECTED, BLOCKED, ON_HOLD — is now
 *    IN_PROGRESS; APPROVED is COMPLETED; DECLINED is CANCELLED. The four
 *    statuses from BEFORE that rework (Todo/InProgress/Review/Done) are mapped
 *    too, because rows carrying them may still exist. The mapping is
 *    config/tasks.LEGACY_STATUS_MAP, shared with the model's own hook, so a row
 *    this script has not reached yet still reads correctly.
 *
 * 2. `completedLate` DID NOT EXIST. It is the In Time / Delayed split on every
 *    dashboard, and it is frozen at completion time rather than derived on
 *    read. For historic rows there is nothing to freeze, so it is reconstructed
 *    once here from `completedAt` against `dueDate` — the best available answer,
 *    and the only chance to compute it before the deadline can be moved again.
 *
 * 3. POINTS DID NOT EXIST ON THE TASK. Every task gets the default (100, or
 *    whatever Setting.tasks.defaultPoints says). Historic COMPLETED tasks are
 *    deliberately NOT credited: `pointsAwardedAt` is left empty, so nothing is
 *    paid retroactively for work finished before points existed. See
 *    services/taskPoints.
 *
 * 4. THREE FEED COLLECTIONS BECAME ONE. TaskActivity, TaskComment and
 *    TaskSubmission are folded into TaskUpdate. Their models are deleted, so
 *    they are read through the RAW DRIVER — a collection with no model is still
 *    a collection. The originals are left completely untouched: this copies,
 *    it does not move, so a bad run can be re-run after clearing TaskUpdate.
 *
 * 5. `watchers` BECAME `loopUsers`. Same idea, the brief's word for it.
 *
 * IDEMPOTENT. Every step either checks first or writes the same value twice.
 * The feed fold is keyed on a `migratedFrom` marker, so a second run copies
 * nothing. Safe to run repeatedly; the second run finds nothing to do.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = require('../config/db');
const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const TaskCategory = require('../models/TaskCategory');
const Setting = require('../models/Setting');
const {
  STATUS, KIND_TASK, normaliseStatus, DEFAULT_TASK_POINTS,
} = require('../config/tasks');

const APPLY = process.argv.includes('--apply');

const stats = {
  tasksSeen: 0, tasksChanged: 0, statusMapped: 0, lateFlagged: 0,
  pointsSet: 0, watchersMoved: 0, assigneesFixed: 0,
  activities: 0, comments: 0, submissions: 0, feedSkipped: 0,
  categories: 0,
};

/** Read a collection that no longer has a model. */
function raw(name) {
  return mongoose.connection.db.collection(name);
}

async function collectionExists(name) {
  const found = await mongoose.connection.db.listCollections({ name }).toArray();
  return found.length > 0;
}

// ===== 1-5. The tasks themselves =====

async function migrateTasks(defaultPoints) {
  const cursor = raw('tasks').find({});
  const ops = [];

  while (await cursor.hasNext()) {
    const t = await cursor.next();
    stats.tasksSeen += 1;
    const set = {};

    // (1) Status
    const status = normaliseStatus(t.status);
    if (status && status !== t.status) {
      set.status = status;
      stats.statusMapped += 1;
    }

    // Assignee rows carry their own status, and the roll-up reads them — a
    // task mapped to COMPLETED whose assignees still say SUBMITTED would be
    // rolled straight back to IN_PROGRESS on its next save.
    if (Array.isArray(t.assignees) && t.assignees.length) {
      const fixed = t.assignees.map((a) => {
        const s = normaliseStatus(a.status) || STATUS.PENDING;
        return { ...a, status: s };
      });
      if (fixed.some((a, i) => a.status !== t.assignees[i].status)) {
        set.assignees = fixed;
        stats.assigneesFixed += 1;
      }
    } else if (t.assignedTo) {
      // A row from before multi-assignee. Give it the one-person array the
      // model now maintains, or every per-person query misses it.
      set.assignees = [{
        user: t.assignedTo,
        status: normaliseStatus(t.status) || STATUS.PENDING,
        completedAt: t.completedAt,
        completedLate: false,
      }];
      stats.assigneesFixed += 1;
    }

    // (2) In Time / Delayed — reconstructed once, here. See the docblock.
    const finished = (set.status || t.status) === STATUS.COMPLETED;
    if (finished && t.completedLate === undefined) {
      const late = Boolean(t.completedAt && t.dueDate
        && new Date(t.completedAt) > new Date(t.dueDate));
      set.completedLate = late;
      if (Array.isArray(set.assignees || t.assignees)) {
        set.assignees = (set.assignees || t.assignees).map((a) => ({
          ...a,
          completedLate: a.completedLate === undefined
            ? Boolean(a.completedAt && t.dueDate && new Date(a.completedAt) > new Date(t.dueDate))
            : a.completedLate,
        }));
      }
      if (late) stats.lateFlagged += 1;
    }

    // (3) Points — the figure, never the credit.
    if (t.points === undefined || t.points === null) {
      // An old row's `incentive.points` is the closest thing to an intention
      // somebody expressed; honour it when it is there.
      const carried = Number(t?.incentive?.points);
      set.points = t.kind === 'REQUEST'
        ? 0
        : (Number.isFinite(carried) && carried > 0 ? Math.round(carried) : defaultPoints);
      stats.pointsSet += 1;
    }

    // (4) kind
    if (!t.kind) set.kind = KIND_TASK;

    // (5) watchers → loopUsers
    if (Array.isArray(t.watchers) && t.watchers.length && !t.loopUsers?.length) {
      set.loopUsers = t.watchers;
      stats.watchersMoved += 1;
    }

    // The repeat block, from whatever the old recurrence fields said.
    if (!t.repeat) set.repeat = { frequency: 'ONCE' };

    // A moved deadline used to be tracked as `originalDueDate`; keep it.
    if (t.dueDate && !t.originalDueDate) set.originalDueDate = t.dueDate;

    if (Object.keys(set).length) {
      stats.tasksChanged += 1;
      ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: set } } });
    }

    if (ops.length >= 500 && APPLY) {
      await raw('tasks').bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }

  if (ops.length && APPLY) await raw('tasks').bulkWrite(ops, { ordered: false });
}

// ===== 4. The feed =====

/**
 * Copy one old row into TaskUpdate.
 *
 * `migratedFrom` is the idempotence key: a second run finds the row already
 * there and skips it, so this can be re-run after a partial failure without
 * doubling anybody's history.
 */
async function foldFeed() {
  const jobs = [
    {
      name: 'taskactivities',
      counter: 'activities',
      map: (r) => ({
        task: r.task,
        kind: r.kind === 'comment' ? 'COMMENT' : (r.to ? 'STATUS' : 'EDITED'),
        by: r.by,
        byName: r.byName || 'Somebody',
        from: normaliseStatus(r.from) || undefined,
        to: normaliseStatus(r.to) || undefined,
        note: [r.message, r.note].filter(Boolean).join(' — ').slice(0, 5000),
        system: !r.by,
        createdAt: r.at || r.createdAt,
      }),
    },
    {
      name: 'taskcomments',
      counter: 'comments',
      // A deleted comment stays deleted: `deletedAt` rows are not copied.
      filter: { deletedAt: null },
      map: (r) => ({
        task: r.task,
        kind: 'COMMENT',
        by: r.author,
        byName: r.authorName || 'Somebody',
        note: (r.body || '').slice(0, 5000),
        files: (r.attachments || []).map((a) => ({
          name: a.name,
          storagePath: a.storagePath,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          kind: a.kind || 'document',
        })).filter((f) => f.storagePath),
        mentions: r.mentions || [],
        createdAt: r.createdAt,
      }),
    },
    {
      name: 'tasksubmissions',
      counter: 'submissions',
      map: (r) => ({
        task: r.task,
        kind: 'STATUS',
        by: r.submittedBy,
        byName: r.submittedByName || 'Somebody',
        to: STATUS.IN_PROGRESS,
        // An attempt number is meaningless now there is nothing to resubmit
        // to, but "handed back" is still what happened, so it is said plainly.
        note: [`Handed back${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''}.`, r.remarks]
          .filter(Boolean).join(' ').slice(0, 5000),
        files: (r.evidence || []).map((a) => ({
          name: a.name,
          storagePath: a.storagePath,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          kind: a.kind || 'document',
        })).filter((f) => f.storagePath),
        createdAt: r.submittedAt || r.createdAt,
      }),
    },
  ];

  for (const job of jobs) {
    if (!(await collectionExists(job.name))) continue;
    const rows = await raw(job.name).find(job.filter || {}).toArray();
    for (const r of rows) {
      const marker = `${job.name}:${r._id}`;
      if (await TaskUpdate.exists({ migratedFrom: marker })) {
        stats.feedSkipped += 1;
        continue;
      }
      const doc = job.map(r);
      if (!doc.task) { stats.feedSkipped += 1; continue; }
      stats[job.counter] += 1;
      if (!APPLY) continue;
      await raw('taskupdates').insertOne({
        ...doc,
        migratedFrom: marker,
        createdAt: doc.createdAt || new Date(),
        updatedAt: doc.createdAt || new Date(),
      });
    }
  }
}

// ===== Categories =====

/**
 * Seed the managed list from what the tasks are already filed under.
 *
 * `category` used to be free text, so this is also the moment "Sales", "sales"
 * and "Sales " become one row — the upsert is case-insensitive, matching the
 * unique index on models/TaskCategory.
 */
async function seedCategories() {
  const names = await raw('tasks').distinct('category');
  const depts = await raw('tasks').distinct('department');
  const all = [...new Set([...names, ...depts]
    .map((n) => String(n || '').trim())
    .filter(Boolean))];

  for (const name of all) {
    const existing = await TaskCategory.findOne({ name })
      .collation({ locale: 'en', strength: 2 });
    if (existing) continue;
    stats.categories += 1;
    if (APPLY) await TaskCategory.create({ name });
  }
}

async function run() {
  await connectDB();
  console.log(APPLY ? 'Migrating tasks to the 2026-09-21 shape…\n' : 'DRY RUN — nothing will be written.\n');

  let defaultPoints = DEFAULT_TASK_POINTS;
  try {
    const s = await Setting.getSettings();
    if (Number.isFinite(s?.tasks?.defaultPoints)) defaultPoints = s.tasks.defaultPoints;
  } catch { /* the default stands */ }

  await migrateTasks(defaultPoints);
  await foldFeed();
  await seedCategories();

  console.log('Tasks');
  console.log(`  seen                    ${stats.tasksSeen}`);
  console.log(`  changed                 ${stats.tasksChanged}`);
  console.log(`  status remapped         ${stats.statusMapped}`);
  console.log(`  assignee rows fixed     ${stats.assigneesFixed}`);
  console.log(`  marked delayed          ${stats.lateFlagged}`);
  console.log(`  points set              ${stats.pointsSet} (at ${defaultPoints} each)`);
  console.log(`  watchers → loop         ${stats.watchersMoved}`);
  console.log('\nFeed folded into TaskUpdate');
  console.log(`  from activities         ${stats.activities}`);
  console.log(`  from comments           ${stats.comments}`);
  console.log(`  from submissions        ${stats.submissions}`);
  console.log(`  already there / skipped ${stats.feedSkipped}`);
  console.log('\nCategories');
  console.log(`  created                 ${stats.categories}`);

  console.log('\nNOTE: no historic task was credited with points. Work finished before');
  console.log('points existed is not paid for retroactively — see services/taskPoints.');

  if (!APPLY) console.log('\nNothing was written. Re-run with --apply.');
}

run()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
