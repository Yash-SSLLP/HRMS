/**
 * Every notification this module sends, in one file.
 *
 * REWRITTEN 2026-09-21 alongside the rest of the module. The principle did not
 * change and is worth restating: notifications are spread across a module's
 * controllers exactly once, after which the same event has three wordings and
 * one path quietly tells nobody. They live here.
 *
 * IT DOES NOT SEND ANYTHING ITSELF. Everything goes through services/notify.js,
 * which writes the in-app row and pushes to the phone together. What this adds
 * is the module's vocabulary: who cares about which event, which portal the
 * alert belongs in, and where tapping it should land.
 *
 * THE PORTAL MATTERS. `audience` decides which portal a dual-role account reads
 * an alert in. A task you have to DO is employee-portal news even when you are
 * an HR Manager; a task you HANDED OUT is admin-portal news. Getting this wrong
 * is the difference between an alert somebody finds and one they never see.
 *
 * NOBODY IS TOLD THEIR OWN DOING. `recipients` always drops the actor. The
 * single most reliable way to make people stop reading notifications is to send
 * them one every time they press a button.
 */
const { notify, notifyMany } = require('./notify');
const { statusLabel, STATUS, KIND_REQUEST } = require('../config/tasks');

/** A deep link to one task, per portal. See the app's PATH_SCREENS table. */
const employeeTaskLink = (id) => `/employee/tasks/${id}`;
const adminTaskLink = (id) => `/admin/tasks/${id}`;

const fmtDateTime = (d) => new Date(d).toLocaleString('en-IN', {
  day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  hour12: true, timeZone: 'Asia/Kolkata',
});

const nameOf = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || 'Somebody';

/** "TSK-2026-00042 — Sales report", or just the title on a pre-code row. */
const taskName = (task) => (task.code ? `${task.code} — ${task.title}` : `"${task.title}"`);

/** The word for this row in a sentence. */
const noun = (task) => (task.kind === KIND_REQUEST ? 'request' : 'task');

/** The tail that makes a bare title actionable — "· High · due 12 Mar, 6:00 pm". */
function meta(task) {
  const bits = [];
  if (task.priority && task.priority !== 'Medium') bits.push(task.priority);
  if (task.dueDate) bits.push(`due ${fmtDateTime(task.dueDate)}`);
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/** Ids as strings, deduped, with the actor removed. */
function recipients(ids, actorId) {
  const skip = String(actorId || '');
  return [...new Set((ids || []).filter(Boolean).map((i) => String(i._id || i)))]
    .filter((id) => id !== skip);
}

const ids = (list) => (list || []).map((x) => String(x?.user?._id || x?.user || x?._id || x));

/**
 * WHOEVER FIRST HAD THIS TASK, and anybody who has held it since.
 *
 * The user's rule, added 2026-09-21: *"the user who got the task in the
 * beginning will receive notification for every update"*. Delegating a task on
 * takes you out of `assignees` but not out of this list, so the person who was
 * originally asked keeps seeing what became of it — which is the whole reason
 * delegating is safe to allow.
 *
 * Every function below adds this to its own audience. It is a separate helper
 * rather than a line inside each one because "and the original assignees" is
 * the single easiest thing in this file to forget on a new event, and forgetting
 * it is silent.
 */
const followers = (task) => (task?.originalAssignees || []).map(String);

/**
 * Everyone who should hear, for an event with no special routing.
 *
 * The assigner, the people on it, the loop, the followers, and anybody who owns
 * a subtask. `Task.audience()` already composes all five — this is the lean
 * fallback for when the caller has a plain object rather than a document.
 */
function everyone(task) {
  if (typeof task.audience === 'function') return task.audience();
  const out = new Set();
  if (task.createdBy) out.add(String(task.createdBy._id || task.createdBy));
  for (const a of task.assignees || []) out.add(String(a.user?._id || a.user));
  for (const u of task.loopUsers || []) out.add(String(u._id || u));
  for (const u of task.originalAssignees || []) out.add(String(u._id || u));
  for (const st of task.subtasks || []) if (st.assignee) out.add(String(st.assignee._id || st.assignee));
  return [...out].filter(Boolean);
}

/**
 * A new task has been handed over.
 *
 * The people ON it hear about it in the employee portal — it is work they have
 * to do. The people kept IN THE LOOP hear about it in the admin portal, because
 * they are watching rather than doing.
 */
async function assigned(task, actor) {
  const label = noun(task);
  const doers = recipients(ids(task.assignees), actor?._id);
  if (doers.length) {
    await notifyMany(doers, {
      type: 'task',
      audience: 'employee',
      title: task.kind === KIND_REQUEST
        ? `${nameOf(actor)} needs something from you`
        : `New task from ${nameOf(actor)}`,
      body: `${taskName(task)}${meta(task)}`,
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), kind: task.kind },
    });
  }

  const watchers = recipients(task.loopUsers, actor?._id).filter((id) => !doers.includes(id));
  if (watchers.length) {
    const who = (task.assignees || []).map((a) => a.name).filter(Boolean).join(', ');
    await notifyMany(watchers, {
      type: 'task',
      audience: 'admin',
      title: `You are in the loop on a ${label}`,
      body: `${taskName(task)}${who ? ` · ${who}` : ''}${meta(task)}`,
      link: adminTaskLink(task._id),
      data: { taskId: String(task._id), kind: task.kind },
    });
  }
}

/**
 * Somebody moved it.
 *
 * The assigner and the loop hear in the admin portal — this is news about work
 * they handed out. Co-assignees hear in the employee portal, because it is news
 * about work that is still partly theirs.
 */
async function statusMoved(task, update, actor) {
  const label = noun(task);
  const word = statusLabel(update.to, task.kind).toLowerCase();
  const line = update.note
    ? `${nameOf(actor)}: ${String(update.note).slice(0, 140)}`
    : `${nameOf(actor)} marked it ${word}.`;

  // The assigner, the loop, AND everyone who has ever held this task — see
  // `followers`. They are watching rather than doing, so it is admin-portal news.
  const overseers = recipients(
    [task.createdBy, ...(task.loopUsers || []), ...followers(task)],
    actor?._id
  );
  if (overseers.length) {
    await notifyMany(overseers, {
      type: 'task',
      audience: 'admin',
      title: `${taskName(task)} is ${word}`,
      body: line,
      link: adminTaskLink(task._id),
      data: { taskId: String(task._id), kind: task.kind, status: update.to },
    });
  }

  const others = recipients(ids(task.assignees), actor?._id).filter((id) => !overseers.includes(id));
  if (others.length) {
    await notifyMany(others, {
      type: 'task',
      audience: 'employee',
      title: `${taskName(task)} is ${word}`,
      body: line,
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), kind: task.kind, status: update.to },
    });
  }

  // Being taken off a cancelled task, or handed back a reopened one, is worth
  // saying plainly rather than as a status word in a list.
  if (update.to === STATUS.CANCELLED) {
    const doers = recipients(ids(task.assignees), actor?._id);
    if (doers.length) {
      await notifyMany(doers, {
        type: 'task',
        audience: 'employee',
        title: `${nameOf(actor)} called off a ${label}`,
        body: `${taskName(task)}${update.note ? ` — ${String(update.note).slice(0, 140)}` : ''}`,
        link: employeeTaskLink(task._id),
        data: { taskId: String(task._id) },
      });
    }
  }
}

/** A remark. Everyone on the task hears, plus anybody named with @. */
async function commented(task, update, actor) {
  const body = update.note
    ? String(update.note).slice(0, 160)
    : (update.voiceNote ? 'Sent a voice note.' : 'Attached a file.');

  const all = recipients(everyone(task), actor?._id);

  if (all.length) {
    await notifyMany(all, {
      type: 'task',
      audience: 'all',
      title: `${nameOf(actor)} on ${taskName(task)}`,
      body,
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id) },
    });
  }

  // Somebody named in the remark who is not otherwise on the task — the video's
  // "teammate can even tag other teammates".
  const named = recipients(update.mentions, actor?._id).filter((id) => !all.includes(id));
  for (const id of named) {
    await notify({
      recipient: id,
      sender: actor?._id,
      type: 'task',
      audience: 'all',
      title: `${nameOf(actor)} mentioned you`,
      body: `${taskName(task)} — ${body}`,
      link: employeeTaskLink(task._id),
    });
  }
}

// ===== Accept / decline / delegate =====

/**
 * Somebody took it on.
 *
 * Quiet, and deliberately so: this is good news that nobody has to act on, and
 * a push for every acknowledgement is how people learn to swipe them away. Only
 * the assigner and the followers hear — the other doers do not care.
 */
async function accepted(task, update, actor) {
  const to = recipients([task.createdBy, ...followers(task)], actor?._id);
  if (!to.length) return;
  await notifyMany(to, {
    type: 'task',
    audience: 'admin',
    title: `${nameOf(actor)} accepted ${taskName(task)}`,
    body: update.note && update.note !== 'Accepted this.' ? update.note : `Due ${task.dueDate ? fmtDateTime(task.dueDate) : 'whenever'}.`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), acceptance: 'ACCEPTED' },
  });
}

/**
 * Somebody said no.
 *
 * THE LOUD ONE. A declined task is work that is now nobody's, and the person
 * who set it has to reassign, delegate or call it off — so the reason travels
 * in the body rather than being left behind a tap.
 */
async function declined(task, update, actor) {
  const to = recipients([task.createdBy, ...(task.loopUsers || []), ...followers(task)], actor?._id);
  if (!to.length) return;
  await notifyMany(to, {
    type: 'task',
    audience: 'admin',
    title: `${nameOf(actor)} cannot take on ${taskName(task)}`,
    body: String(update.note || '').slice(0, 200),
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), acceptance: 'REJECTED' },
  });
}

/**
 * It changed hands.
 *
 * Three different messages, because three different people need three different
 * things: the new owner needs to know it is theirs, the assigner needs to know
 * who has it now, and the followers need the trail.
 */
async function delegated(task, update, actor, newAssignee) {
  const label = noun(task);

  if (newAssignee?.user) {
    await notifyMany([String(newAssignee.user)], {
      type: 'task',
      audience: 'employee',
      title: `${nameOf(actor)} passed you a ${label}`,
      body: `${taskName(task)}${meta(task)}`,
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), delegated: true },
    });
  }

  const watching = recipients(
    [task.createdBy, ...(task.loopUsers || []), ...followers(task)],
    actor?._id
  ).filter((id) => id !== String(newAssignee?.user || ''));

  if (watching.length) {
    await notifyMany(watching, {
      type: 'task',
      audience: 'admin',
      title: `${taskName(task)} passed to ${newAssignee?.name || 'somebody else'}`,
      body: String(update.note || `${nameOf(actor)} passed it on.`).slice(0, 200),
      link: adminTaskLink(task._id),
      data: { taskId: String(task._id), delegated: true },
    });
  }
}

// ===== Subtasks =====

/**
 * The task has been split up.
 *
 * The people who were given a PIECE hear about their piece by name; everybody
 * else gets one line saying it happened. Sending every doer a notification per
 * subtask would mean five pushes for one act of planning.
 */
async function subtasksAdded(task, update, actor, added = []) {
  const owners = new Map();
  for (const st of added) {
    if (!st.assignee) continue;
    const id = String(st.assignee);
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push(st.title);
  }

  for (const [id, titles] of owners) {
    if (id === String(actor?._id)) continue;
    await notifyMany([id], {
      type: 'task',
      audience: 'employee',
      title: titles.length === 1 ? 'A piece of work is yours' : `${titles.length} pieces are yours`,
      body: `${taskName(task)} — ${titles.slice(0, 3).join('; ')}`,
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), subtask: true },
    });
  }

  const rest = recipients(everyone(task), actor?._id).filter((id) => !owners.has(id));
  if (rest.length) {
    await notifyMany(rest, {
      type: 'task',
      audience: 'all',
      title: `${taskName(task)} was split up`,
      body: String(update.note || '').slice(0, 200),
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), subtask: true },
    });
  }
}

/**
 * A piece was ticked off (or reopened).
 *
 * Only the assigner and the followers — the other doers see the progress line
 * on the task itself, and a push each time somebody ticks one of eight boxes is
 * a push nobody reads by the third one.
 */
async function subtaskMoved(task, update, actor) {
  const to = recipients([task.createdBy, ...followers(task)], actor?._id);
  if (!to.length) return;
  const { done, total } = typeof task.subtaskProgress === 'function'
    ? task.subtaskProgress()
    : { done: 0, total: 0 };
  await notifyMany(to, {
    type: 'task',
    audience: 'admin',
    title: `${taskName(task)} — ${done} of ${total} done`,
    body: String(update.note || '').slice(0, 200),
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), subtask: true },
  });
}

/** The assigner changed something after the fact. */
async function edited(task, actor, what = '') {
  const doers = recipients(ids(task.assignees), actor?._id);
  if (!doers.length) return;
  await notifyMany(doers, {
    type: 'task',
    audience: 'employee',
    title: `${nameOf(actor)} updated a ${noun(task)}`,
    body: `${taskName(task)}${what ? ` — ${what}` : ''}${meta(task)}`,
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id) },
  });
}

/**
 * A scheduled chase — the reminder worker's only way out.
 *
 * `to` is the list of user ids; the worker decides who (the doers before the
 * deadline, the assigner and the loop after it).
 */
async function reminder(task, to, { title, body, portal = 'employee' }) {
  const list = recipients(to, null);
  if (!list.length) return;
  await notifyMany(list, {
    type: 'task',
    audience: portal === 'admin' ? 'admin' : 'employee',
    title,
    body,
    link: portal === 'admin' ? adminTaskLink(task._id) : employeeTaskLink(task._id),
    data: { taskId: String(task._id), reminder: true },
  });
}

/** The evening "you have N pending" summary. One notification, not N. */
async function digest(userId, { pending, overdue }) {
  const bits = [];
  if (overdue) bits.push(`${overdue} overdue`);
  if (pending) bits.push(`${pending} pending`);
  if (!bits.length) return;
  await notify({
    recipient: userId,
    type: 'task',
    audience: 'employee',
    title: 'Your tasks today',
    body: `You have ${bits.join(' and ')}.`,
    link: '/employee/tasks',
  });
}

module.exports = {
  assigned,
  statusMoved,
  accepted,
  declined,
  delegated,
  subtasksAdded,
  subtaskMoved,
  commented,
  edited,
  reminder,
  digest,
};
