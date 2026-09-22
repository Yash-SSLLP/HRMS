/**
 * Bring the task module's live data onto the 2026-09-22 shape.
 *
 *   node scripts/migrateTasksV4.js          # report what it would do
 *   node scripts/migrateTasksV4.js --apply  # actually do it
 *
 * WHAT CHANGED, AND WHAT THIS HAS TO DO ABOUT IT.
 *
 * 1. PRIORITY IS `Urgent / Medium / Low`. It was `High / Medium / Low`, and the
 *    live data had already drifted on its own: of 59 rows, FIFTY carried
 *    `Urgent` — a word no picker offered and no filter matched, left behind by
 *    a rework that renamed the level without migrating the rows. That is why
 *    the rename goes this way round rather than the other: `Urgent` is the word
 *    the company is already using. `High`, `Critical` and `Highest` become
 *    `Urgent`; `Normal` becomes `Medium`; `Lowest` becomes `Low`.
 *
 * 2. THERE IS A FOURTH STATE, `SUBMITTED` ("In review"). Nothing migrates INTO
 *    it — a task nobody has handed in is not in review — but the old
 *    twelve-status words `UNDER_REVIEW` and `Review` now mean it rather than
 *    IN_PROGRESS, so any row still carrying them lands in the right column.
 *    This also runs V3's status map, because V3 WAS NEVER RUN against this
 *    database: 49 rows are still `ASSIGNED` and one is still `Done`.
 *
 * 3. EVERY TASK NEEDS `requiresApproval`. Default true for a task, false for a
 *    request. Historic rows get it so the review rule reads the same on a task
 *    set last month as on one set today.
 *
 * 4. PROGRESS DID NOT EXIST. A completed row is 100%, everything else is 0 —
 *    the only honest answers. Nothing is inferred from elapsed time.
 *
 * 5. EMBEDDED SUBTASKS BECAME CHILD TASKS. There were ZERO embedded subtasks in
 *    the live data when this landed, which is why the old array was removed
 *    outright rather than deprecated. This still handles them: any that turn up
 *    (a restored backup, another environment) become real child tasks carrying
 *    an equal share of the parent's points. The embedded array is then cleared
 *    so a re-run cannot duplicate them.
 *
 * 6. `completedLate` ON A SUBMITTED ROW is now frozen at SUBMISSION rather than
 *    at approval. Nothing to migrate — no row has ever been submitted — but the
 *    reconstruction V3 did from `completedAt` is repeated here for any row that
 *    still has no flag, because it is the last chance to compute it before a
 *    deadline can be moved again.
 *
 * IDEMPOTENT. Every step either checks first or writes the same value twice.
 * Safe to run repeatedly; the second run finds nothing to do.
 */
const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = require('../config/db');
const Task = require('../models/Task');
const TaskCategory = require('../models/TaskCategory');
const {
  STATUS, KIND_TASK, KIND_REQUEST, normaliseStatus, normalisePriority, DEFAULT_PRIORITY,
} = require('../config/tasks');

const APPLY = process.argv.includes('--apply');

const stats = {
  seen: 0,
  statusMapped: 0,
  priorityMapped: 0,
  approvalSet: 0,
  progressSet: 0,
  lateFlagged: 0,
  countersSet: 0,
  subtasksConverted: 0,
  parentsRecomputed: 0,
  categories: 0,
};

/** Read the collection raw — a field the schema no longer declares is invisible
 *  through the model, and `subtasks` is exactly that. */
function raw(name) {
  return mongoose.connection.db.collection(name);
}

// ===== 1-4, 6. The tasks themselves =====

async function migrateTasks() {
  const cursor = raw('tasks').find({});
  const ops = [];

  while (await cursor.hasNext()) {
    const t = await cursor.next();
    stats.seen += 1;
    const set = {};

    // 2. status
    const status = normaliseStatus(t.status);
    if (status && status !== t.status) {
      set.status = status;
      stats.statusMapped += 1;
    }
    const assignees = (t.assignees || []).map((a) => {
      const s = normaliseStatus(a.status);
      return s && s !== a.status ? { ...a, status: s } : a;
    });
    if (assignees.some((a, i) => a.status !== (t.assignees || [])[i]?.status)) {
      set.assignees = assignees;
    }

    // 1. priority
    const priority = normalisePriority(t.priority) || DEFAULT_PRIORITY;
    if (priority !== t.priority) {
      set.priority = priority;
      stats.priorityMapped += 1;
    }

    // 3. requiresApproval
    if (t.requiresApproval === undefined) {
      set.requiresApproval = (t.kind || KIND_TASK) === KIND_TASK;
      stats.approvalSet += 1;
    }

    // 4. progress — on the task and on every row that has none
    const finalStatus = set.status || t.status;
    if (t.progress === undefined) {
      set.progress = finalStatus === STATUS.COMPLETED ? 100 : 0;
      stats.progressSet += 1;
    }
    const rows = set.assignees || t.assignees || [];
    if (rows.some((a) => a.progress === undefined)) {
      set.assignees = rows.map((a) => (a.progress === undefined
        ? { ...a, progress: a.status === STATUS.COMPLETED ? 100 : 0 }
        : a));
    }

    // 5/§counters — the pieces' figures, zeroed so a list can read them before
    // anything has ever been split.
    if (t.childCount === undefined || t.distributedPoints === undefined) {
      set.childCount = t.childCount || 0;
      set.childDoneCount = t.childDoneCount || 0;
      set.distributedPoints = t.distributedPoints || 0;
      set.depth = t.depth || 0;
      stats.countersSet += 1;
    }

    // 6. completedLate, reconstructed once — V3's step, repeated because V3 was
    // never run here.
    if (t.completedLate === undefined && (set.status || t.status) === STATUS.COMPLETED) {
      set.completedLate = Boolean(t.dueDate && t.completedAt
        && new Date(t.completedAt) > new Date(t.dueDate));
      stats.lateFlagged += 1;
    }

    if (Object.keys(set).length) {
      ops.push({ updateOne: { filter: { _id: t._id }, update: { $set: set } } });
    }
  }

  if (ops.length && APPLY) await raw('tasks').bulkWrite(ops, { ordered: false });
  return ops.length;
}

// ===== 5. Embedded subtasks → child tasks =====

/**
 * Turn any embedded piece into a real child Task.
 *
 * Expected to find nothing: the live data had zero when this landed. It exists
 * so that a restored backup, or another environment that DID use them, is not
 * silently emptied — a piece somebody was named for is a job, and dropping the
 * array without converting it would lose work nobody could get back.
 *
 * Points are split equally out of whatever the parent had, which is the same
 * default the split form uses (services/taskEngine.shareOut).
 */
async function convertSubtasks() {
  const parents = await raw('tasks').find({ 'subtasks.0': { $exists: true } }).toArray();
  if (!parents.length) return 0;

  for (const p of parents) {
    const pieces = (p.subtasks || []).filter((st) => st && st.title);
    if (!pieces.length) continue;

    const pool = Math.max(0, Number(p.points) || 0);
    const base = Math.floor(pool / pieces.length);
    let spare = pool - base * pieces.length;

    const docs = pieces.map((st) => {
      const share = base + (spare > 0 ? 1 : 0);
      if (spare > 0) spare -= 1;
      return {
        kind: KIND_TASK,
        title: String(st.title).slice(0, 300),
        category: p.category,
        company: p.company,
        createdBy: st.addedBy || p.createdBy,
        createdByName: st.addedByName || p.createdByName,
        parentTask: p._id,
        parentCode: p.code,
        parentTitle: p.title,
        depth: 1,
        assignees: st.assignee
          ? [{
            user: st.assignee,
            name: st.assigneeName || '',
            status: st.done ? STATUS.COMPLETED : STATUS.PENDING,
            completedAt: st.done ? (st.doneAt || new Date()) : undefined,
            progress: st.done ? 100 : 0,
          }]
          : [],
        // Without an owner it was open to everybody on the parent, which is the
        // closest thing the old shape had to `openTo`.
        openTo: st.assignee ? [] : (p.assignees || []).map((a) => a.user).filter(Boolean),
        loopUsers: [p.createdBy].filter(Boolean),
        points: share,
        priority: normalisePriority(p.priority) || DEFAULT_PRIORITY,
        dueDate: p.dueDate,
        requiresApproval: false,   // it was a tick box; it never had a review
        status: st.done ? STATUS.COMPLETED : STATUS.PENDING,
        progress: st.done ? 100 : 0,
        completedAt: st.done ? (st.doneAt || new Date()) : undefined,
        assignedAt: p.assignedAt || p.createdAt || new Date(),
        archived: false,
      };
    });

    stats.subtasksConverted += docs.length;
    if (!APPLY) continue;

    // Through the MODEL, so the code (TSK-…) is stamped and the roll-up hooks
    // run — a child inserted raw would have no code and no derived status.
    const made = await Task.create(docs);
    await raw('tasks').updateOne(
      { _id: p._id },
      {
        $set: {
          childCount: made.length,
          childDoneCount: made.filter((c) => c.status === STATUS.COMPLETED).length,
          distributedPoints: made.reduce((s, c) => s + (c.points || 0), 0),
        },
        // Cleared so a second run cannot convert the same pieces twice.
        $unset: { subtasks: '' },
      }
    );
    stats.parentsRecomputed += 1;
  }
  return stats.subtasksConverted;
}

// ===== Categories, in case V3 never ran =====

async function seedCategories() {
  const names = await raw('tasks').distinct('category', { category: { $nin: [null, ''] } });
  for (const name of names) {
    const exists = await TaskCategory.findOne({ name })
      .collation({ locale: 'en', strength: 2 }).lean();
    if (exists) continue;
    stats.categories += 1;
    if (APPLY) await TaskCategory.create({ name, isActive: true });
  }
}

(async () => {
  await connectDB();
  console.log(APPLY ? '=== APPLYING ===' : '=== DRY RUN (add --apply to write) ===');

  const touched = await migrateTasks();
  await convertSubtasks();
  await seedCategories();

  console.log(JSON.stringify({ ...stats, tasksTouched: touched }, null, 2));
  console.log(APPLY ? 'Done.' : 'Nothing written. Re-run with --apply.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
