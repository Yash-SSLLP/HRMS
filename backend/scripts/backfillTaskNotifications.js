/**
 * Tell people about the tasks they were already given.
 *
 *   node scripts/backfillTaskNotifications.js          # report what it would send
 *   node scripts/backfillTaskNotifications.js --apply  # actually send it
 *
 * WHY. Assigning a task used to be silent: the row appeared under My Tasks and
 * that was the whole of it, so the only people who knew a task existed were the
 * ones who happened to open the page. The module notifies both ways now — the
 * assignee when a task lands on them, whoever assigned it when they move it —
 * but that only governs tasks handed over from here on. Every task already on
 * file is still sitting in a list nobody was told about.
 *
 * WHAT IT SKIPS, and why each one is a skip rather than a send:
 *   · no assignee      — there is nobody to tell.
 *   · already Done     — "you have a task" about work that is finished is noise,
 *                        and it is the one status that needs no action.
 *   · the person left  — a deactivated login, or one whose last working day has
 *                        passed, is in no picker anywhere else either
 *                        (utils/departed). Their phone is not ours to buzz.
 *   · already told     — a task notification whose body already quotes this
 *                        title, for this person. That is what makes the script
 *                        safe to run twice, and safe to run after the feature
 *                        has been live for a while: the tasks assigned since
 *                        deploy are skipped because the module already sent
 *                        theirs.
 *
 * Every send goes through notify(), exactly as the controller does, so a
 * backfilled alert is an in-app row AND a push, worded and linked identically
 * to a live one. It passes `awaitPush` — a request may fire the push and move
 * on, but a script disconnects Mongo and exits the moment the loop ends, and an
 * in-flight push that has not yet read DeviceToken dies with "Client must be
 * connected". The rows land, every phone stays quiet, and nothing says so.
 *
 * The thing to look at before running with --apply: the dry run prints a
 * per-person count, and N tasks for one person is N pushes to their phone.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Task = require('../models/Task');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { notify } = require('../services/notify');
const { departedUserIdSet } = require('../utils/departed');
const { taskMeta, EMPLOYEE_LINK } = require('../controllers/taskController');

const APPLY = process.argv.includes('--apply');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

/** Escape a task title for use inside a regex — titles are free text. */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Has this person already been told about this task?
 *
 * Matched on the QUOTED title inside the body, because that is the only part of
 * the sentence that identifies the task and the only part that cannot have
 * drifted since: the priority and due date in the tail may well have been
 * edited after the notification went out. Two open tasks with the same title
 * for the same person collapse into one send, which is the right way round to
 * be wrong on a backfill.
 * @param {*} userId
 * @param {string} title
 * @returns {Promise<boolean>}
 */
async function alreadyTold(userId, title) {
  const hit = await Notification.findOne({
    recipient: userId,
    type: 'task',
    body: { $regex: `"${escapeRe(title)}"` },
  }).select('_id').lean();
  return !!hit;
}

async function run() {
  await connectDB();

  const tasks = await Task.find({
    assignedTo: { $ne: null },
    status: { $ne: 'Done' },
  })
    .select('title priority dueDate status assignedTo createdAt')
    .sort({ createdAt: 1 })
    .lean();

  console.log(`${tasks.length} open task(s) with an assignee\n`);
  if (!tasks.length) return;

  // One lookup for all of them rather than one per task.
  const assigneeIds = [...new Set(tasks.map((t) => String(t.assignedTo)))];
  const gone = await departedUserIdSet(assigneeIds);
  const nameById = new Map(
    (await User.find({ _id: { $in: assigneeIds } }).select('firstName lastName').lean())
      .map((u) => [String(u._id), `${u.firstName || ''} ${u.lastName || ''}`.trim() || String(u._id)])
  );

  const stats = { sent: 0, departed: 0, told: 0 };
  const perPerson = new Map();

  for (const task of tasks) {
    const uid = String(task.assignedTo);
    if (gone.has(uid)) { stats.departed += 1; continue; }
    if (await alreadyTold(task.assignedTo, task.title)) { stats.told += 1; continue; }

    const who = nameById.get(uid) || uid;
    say(`${who.padEnd(24)} ${task.status.padEnd(11)} "${String(task.title).slice(0, 50)}"`);

    if (APPLY) {
      await notify({
        recipient: task.assignedTo,
        type: 'task',
        audience: 'employee',
        title: 'New task assigned',
        body: `"${task.title}"${taskMeta(task)}`,
        link: EMPLOYEE_LINK,
        awaitPush: true,
      });
    }
    stats.sent += 1;
    perPerson.set(who, (perPerson.get(who) || 0) + 1);
  }

  console.log(`\n${APPLY ? 'notified' : 'would notify'}: ${stats.sent}`);
  console.log(`skipped — the person has left:  ${stats.departed}`);
  console.log(`skipped — already told:         ${stats.told}`);

  if (perPerson.size) {
    console.log(`\nper person (each task is one in-app alert AND one push):`);
    [...perPerson.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([who, n]) => console.log(`  ${String(n).padStart(3)}  ${who}`));
  }
  if (!APPLY) console.log('\nNothing was sent. Re-run with --apply to send these.');
}

run()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
