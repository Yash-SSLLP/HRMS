/**
 * Bring the existing tasks onto the reworked module.
 *
 * WHY THIS EXISTS. The Task collection was live before the 2026-09-17 rework —
 * 57 documents, 51 of them an open "Documents Submission" handed to the whole
 * company on 11 September. The rework was additive on purpose (same collection,
 * same `_id`s, every new field defaulted) so nothing was ever broken, but three
 * things still have to be brought forward:
 *
 *   1. STATUS. The four old words become lifecycle states:
 *        Todo → ASSIGNED   InProgress → IN_PROGRESS
 *        Review → UNDER_REVIEW   Done → COMPLETED
 *      Until this runs, such a row is a perfectly valid document that the engine
 *      normalises on the fly — so the portal works either way, and this just
 *      makes the stored value match what everything else reads.
 *   2. ASSIGNEES. `assignedTo` becomes an assignee ROW, so the multi-assignee
 *      shape is what every new code path sees. `assignedTo` itself stays, and is
 *      maintained by the model from that row.
 *   3. CODE, COMPANY, SUPERVISOR, STAMPS. A quotable TSK- reference, the company
 *      the wall reads, the creator as supervisor, and the lifecycle timestamps
 *      inferred from what the row already knows.
 *
 * SAFE TO RUN TWICE. Every step is skipped when it has already been done, so a
 * re-run touches nothing. Nothing is deleted and nothing is overwritten that
 * already has a value.
 *
 * DRY RUN BY DEFAULT — this database is shared with production.
 *   node scripts/migrateTasksV2.js            # report only, writes nothing
 *   node scripts/migrateTasksV2.js --apply    # actually migrate
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const APPLY = process.argv.includes('--apply');

async function main() {
  // connectDB(), not mongoose.connect — the scripts in this repo that connected
  // themselves ended up pointed at the wrong database more than once.
  await connectDB();

  const Task = require('../models/Task');
  const EmployeeProfile = require('../models/EmployeeProfile');
  const User = require('../models/User');
  const { LEGACY_STATUS_MAP, normaliseStatus } = require('../config/taskWorkflow');
  const { nextCode } = require('../services/sequence');

  const all = await Task.find({}).lean();
  console.log(`Found ${all.length} task(s).`);
  if (!all.length) return;

  // One lookup for everybody named on a task, rather than two queries per row.
  const userIds = [...new Set(all.flatMap((t) => [
    t.assignedTo, t.createdBy, ...((t.assignees || []).map((a) => a.user)),
  ]).filter(Boolean).map(String))];

  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: userIds } }).select('firstName lastName').lean(),
    EmployeeProfile.find({ user: { $in: userIds } }).select('user employeeCode department company').lean(),
  ]);
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const profByUser = new Map(profiles.map((p) => [String(p.user), p]));

  const stats = {
    status: 0, assignees: 0, code: 0, company: 0, department: 0,
    supervisor: 0, stamps: 0, originalDue: 0, untouched: 0,
  };
  const samples = [];

  for (const t of all) {
    const set = {};

    // --- 1. status ---
    if (LEGACY_STATUS_MAP[t.status]) {
      set.status = LEGACY_STATUS_MAP[t.status];
      stats.status += 1;
    }
    const status = set.status || normaliseStatus(t.status) || t.status;

    // --- 2. assignees ---
    if (!(t.assignees || []).length && t.assignedTo) {
      const u = userById.get(String(t.assignedTo));
      const p = profByUser.get(String(t.assignedTo));
      set.assignees = [{
        user: t.assignedTo,
        name: u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : undefined,
        employeeCode: p ? p.employeeCode : undefined,
        role: 'Owner',
        status,
        progress: status === 'COMPLETED' ? 100 : 0,
        incentiveEligible: true,
        // The stamps this row can honestly claim. A task that is Done was
        // certainly accepted and started at some point, but we do not know WHEN,
        // and inventing a time would put a fiction in the audit trail. Only
        // `completedAt` is inferable, from the row's own updatedAt.
        ...(status === 'COMPLETED' ? { completedAt: t.updatedAt } : {}),
      }];
      stats.assignees += 1;
    }

    // --- 3. company & department, for the wall and the reports ---
    const owner = t.assignedTo || t.createdBy;
    const prof = owner ? profByUser.get(String(owner)) : null;
    if (!t.company && prof && prof.company) { set.company = prof.company; stats.company += 1; }
    if (!t.department && prof && prof.department) { set.department = prof.department; stats.department += 1; }

    // --- 4. supervisor: whoever handed it over ---
    if (!t.supervisor && t.createdBy) { set.supervisor = t.createdBy; stats.supervisor += 1; }

    // --- 5. the due date it was FIRST given ---
    if (t.dueDate && !t.originalDueDate) { set.originalDueDate = t.dueDate; stats.originalDue += 1; }

    // --- 6. lifecycle stamps we can infer honestly ---
    if (!t.assignedAt) { set.assignedAt = t.createdAt; stats.stamps += 1; }
    if (status === 'COMPLETED' && !t.completedAt) {
      set.completedAt = t.updatedAt || t.createdAt;
      set.closedAt = t.updatedAt || t.createdAt;
    }
    if (status === 'COMPLETED' && (t.progress || 0) !== 100) set.progress = 100;

    // --- 7. the quotable reference ---
    if (!t.code) {
      // Minted from the same atomic counter the live module uses, so a migrated
      // task and one created tomorrow are in one unbroken series. Dated from the
      // task's own createdAt, so 2026's tasks get 2026 codes.
      set.code = APPLY
        ? await nextCode('TSK', t.createdAt)
        : '(TSK-…-…… on apply)';
      stats.code += 1;
    }

    if (!Object.keys(set).length) { stats.untouched += 1; continue; }

    if (samples.length < 5) {
      samples.push({
        id: String(t._id),
        title: t.title,
        was: t.status,
        now: set.status || t.status,
        adds: Object.keys(set).filter((k) => k !== 'status'),
      });
    }

    if (APPLY) {
      // updateOne, not save(): a document save would run the pre-save hooks,
      // which would re-derive progress and re-stamp things this script is
      // deliberately setting by hand. The write is exactly what is listed above.
      await Task.updateOne({ _id: t._id }, { $set: set });
    }
  }

  console.log('');
  console.log(APPLY ? '===== APPLIED =====' : '===== DRY RUN (nothing written) =====');
  console.log(`  statuses converted to the new lifecycle : ${stats.status}`);
  console.log(`  assignee rows created from assignedTo   : ${stats.assignees}`);
  console.log(`  TSK- reference codes minted             : ${stats.code}`);
  console.log(`  company stamped for the wall            : ${stats.company}`);
  console.log(`  department stamped                      : ${stats.department}`);
  console.log(`  supervisor set to the task's creator    : ${stats.supervisor}`);
  console.log(`  original due date preserved             : ${stats.originalDue}`);
  console.log(`  lifecycle stamps filled                 : ${stats.stamps}`);
  console.log(`  already migrated, untouched             : ${stats.untouched}`);

  if (samples.length) {
    console.log('');
    console.log('Examples:');
    for (const s of samples) {
      console.log(`  ${s.id}  "${s.title}"  ${s.was} -> ${s.now}   + ${s.adds.join(', ') || 'nothing else'}`);
    }
  }

  if (!APPLY) {
    console.log('');
    console.log('Nothing was written. Re-run with --apply to migrate.');
  }
}

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Migration failed:', err.message);
    console.error(err.stack);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
