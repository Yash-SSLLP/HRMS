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
const followers = (task) => [
  ...(task?.originalAssignees || []).map(String),
  // NOT whoever set it on somebody else's behalf (Task.onBehalf): it is that
  // person's task, and the sender can no longer open it (taskAccess.canSee), so
  // an update would be a notification leading nowhere. User decision 2026-09-25.
];

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
      // Set on the sender's behalf: say who actually sent it, so a question
      // about it goes to somebody who knows.
      body: `${taskName(task)}${meta(task)}${task.onBehalf?.byName ? ` · sent by ${task.onBehalf.byName}` : ''}`,
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
 * Tell the person a task was set IN THE NAME OF (Task.onBehalf) that it was.
 *
 * They are its setter now — it comes back to them to approve — so they must
 * not first hear of it when the work is handed in. Sent to the admin portal
 * like every other "news about work you handed out".
 */
async function setOnYourBehalf(task, sender) {
  const to = recipients([task.createdBy], sender?._id);
  if (!to.length) return;
  const who = (task.assignees || []).map((a) => a.name).filter(Boolean).join(', ');
  await notifyMany(to, {
    type: 'task',
    audience: 'admin',
    title: `${nameOf(sender)} set a ${noun(task)} on your behalf`,
    body: `${taskName(task)}${who ? ` · for ${who}` : ''}${meta(task)}`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), kind: task.kind },
  });
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

  /**
   * THE THREE MOVES THAT NEED SOMEBODY TO DO SOMETHING (2026-09-22).
   *
   * A submission is a job landing in the assigner's tray, an approval and a
   * rejection are the answers coming back. Each is routed at ONE person and
   * worded as the thing that happened, then we return — falling through to the
   * generic "X is in review" would tell the same person twice, in vaguer words,
   * and bury the one line they have to act on.
   */
  if (update.kind === 'SUBMITTED') {
    // THE APPROVER, not the creator. After a delegation they are different
    // people and only one of them has an Approve button — see
    // models/Task.approver.
    const to = recipients([task.approver || task.createdBy], actor?._id);
    if (to.length) {
      await notifyMany(to, {
        type: 'task',
        audience: 'admin',
        title: `${nameOf(actor)} handed in ${taskName(task)}`,
        body: `${String(update.note || 'Waiting on your approval.').slice(0, 160)}`,
        link: adminTaskLink(task._id),
        data: { taskId: String(task._id), status: update.to, needsReview: true },
      });
    }
    const watchers = recipients([...(task.loopUsers || []), ...followers(task)], actor?._id)
      .filter((id) => !to.includes(id));
    if (watchers.length) {
      await notifyMany(watchers, {
        type: 'task',
        audience: 'admin',
        title: `${taskName(task)} is in review`,
        body: line,
        link: adminTaskLink(task._id),
        data: { taskId: String(task._id), status: update.to },
      });
    }
    return;
  }

  if (update.kind === 'APPROVED' || update.kind === 'SENT_BACK') {
    const yes = update.kind === 'APPROVED';
    const doers = recipients(ids(task.assignees), actor?._id);
    if (doers.length) {
      await notifyMany(doers, {
        type: 'task',
        audience: 'employee',
        title: yes
          ? `${nameOf(actor)} approved ${taskName(task)}`
          : `${nameOf(actor)} sent ${taskName(task)} back`,
        body: yes
          ? `${String(update.note || 'Signed off.').slice(0, 160)}`
          : `${String(update.note || 'It needs another look.').slice(0, 160)}`,
        link: employeeTaskLink(task._id),
        data: { taskId: String(task._id), status: update.to, approved: yes },
      });
    }
    const watchers = recipients([...(task.loopUsers || []), ...followers(task)], actor?._id)
      .filter((id) => !doers.includes(id));
    if (watchers.length) {
      await notifyMany(watchers, {
        type: 'task',
        audience: 'admin',
        title: `${taskName(task)} is ${word}`,
        body: line,
        link: adminTaskLink(task._id),
        data: { taskId: String(task._id), status: update.to },
      });
    }
    return;
  }

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
async function taskSplit(task, update, actor, children = []) {
  // The person NAMED on a piece is being handed a job. That is employee-portal
  // news and it links to the PIECE, not to the parent — the parent is somebody
  // else's task and half of it is nothing to do with them.
  const owned = children.filter((c) => (c.assignees || []).length);
  for (const child of owned) {
    const to = recipients(ids(child.assignees), actor?._id);
    if (!to.length) continue;
    await notifyMany(to, {
      type: 'task',
      audience: 'employee',
      title: `New task from ${nameOf(actor)}`,
      body: `${child.title} — part of ${taskName(task)}${meta(child)}`,
      link: employeeTaskLink(child._id),
      data: { taskId: String(child._id), parentTask: String(task._id), points: child.points },
    });
  }

  // A piece nobody was named for is an OFFER, and it goes to everybody it was
  // offered to. Worded as an offer rather than an instruction, because the one
  // thing that must be obvious is that nobody has been given it yet.
  const open = children.filter((c) => !(c.assignees || []).length);
  for (const child of open) {
    const to = recipients((child.openTo || []).map(String), actor?._id);
    if (!to.length) continue;
    await notifyMany(to, {
      type: 'task',
      audience: 'employee',
      title: 'A piece of work is up for grabs',
      body: `${child.title} — part of ${taskName(task)}. First to pick it up gets it.`,
      link: employeeTaskLink(child._id),
      data: { taskId: String(child._id), parentTask: String(task._id), openPiece: true },
    });
  }

  // Everybody watching the PARENT hears that it was split, once, whatever the
  // pieces turned out to be — the alternative is one push per piece at somebody
  // who is not doing any of them.
  const owners = new Set(children.flatMap((c) => [
    ...ids(c.assignees), ...(c.openTo || []).map(String),
  ]));
  const rest = recipients(everyone(task), actor?._id).filter((id) => !owners.has(id));
  if (rest.length) {
    await notifyMany(rest, {
      type: 'task',
      audience: 'admin',
      title: `${taskName(task)} was split into ${children.length} piece${children.length === 1 ? '' : 's'}`,
      body: children.map((c) => c.title).slice(0, 3).join('; ').slice(0, 200),
      link: adminTaskLink(task._id),
      data: { taskId: String(task._id), split: true },
    });
  }
}

/**
 * A task went to the wrong person and has been handed to the right one.
 *
 * TWO DIFFERENT MESSAGES, because the two audiences need opposite things. The
 * new owner is being given a job and must hear it as one. The person it came
 * off is being told to STOP — and this is the last thing they will ever hear
 * about this task, because a transfer takes them out of the audience entirely
 * (services/taskEngine.transferTask). Saying it plainly here is the only chance
 * to say it at all.
 */
async function transferred(task, update, actor, leaving = []) {
  const to = recipients(ids(task.assignees), actor?._id);
  if (to.length) {
    await notifyMany(to, {
      type: 'task',
      audience: 'employee',
      title: `${taskName(task)} is now yours`,
      body: `${nameOf(actor)} transferred it to you.${meta(task)}`,
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), transferred: true },
    });
  }

  const off = recipients(leaving.map((l) => l.id), actor?._id);
  if (off.length) {
    await notifyMany(off, {
      type: 'task',
      audience: 'employee',
      title: `${taskName(task)} is no longer yours`,
      body: `${nameOf(actor)} transferred it to ${task.assignees?.[0]?.name || 'somebody else'}. `
        + 'You will not hear about it again.',
      link: employeeTaskLink(task._id),
      data: { taskId: String(task._id), transferred: true, removed: true },
    });
  }

  const watchers = recipients(
    [task.createdBy, task.approver, ...(task.loopUsers || [])], actor?._id
  ).filter((id) => !to.includes(id) && !off.includes(id));
  if (watchers.length) {
    await notifyMany(watchers, {
      type: 'task',
      audience: 'admin',
      title: `${taskName(task)} was transferred`,
      body: String(update.note || '').slice(0, 200),
      link: adminTaskLink(task._id),
      data: { taskId: String(task._id), transferred: true },
    });
  }
}

/** Somebody took an open piece. The person who offered it is the one who cares. */
async function pieceClaimed(task, update, actor) {
  const to = recipients([task.createdBy, ...(task.loopUsers || [])], actor?._id);
  if (!to.length) return;
  await notifyMany(to, {
    type: 'task',
    audience: 'admin',
    title: `${nameOf(actor)} picked up ${taskName(task)}`,
    body: task.parentTitle ? `Part of ${task.parentTitle}` : '',
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), claimed: true },
  });
}

/**
 * Somebody moved their progress bar.
 *
 * The assigner and the loop only, and NOT the other doers — a push every time
 * one of four people nudges a slider is four times the noise for none of the
 * information, and the figure is on the row anyway. Held back below 100 unless
 * it is the first report: what an assigner wants to know is "started" and
 * "finished", not "43%".
 */
async function progressSet(task, update, actor, pct) {
  if (pct > 0 && pct < 100 && (task.updateCount || 0) > 3) return;
  const to = recipients([task.createdBy, ...(task.loopUsers || [])], actor?._id);
  if (!to.length) return;
  await notifyMany(to, {
    type: 'task',
    audience: 'admin',
    title: `${taskName(task)} — ${pct}% done`,
    body: `${nameOf(actor)}: ${String(update.note || '').slice(0, 140)}`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), progress: pct },
  });
}

/**
 * Somebody wants longer.
 *
 * Goes UP, to whoever can say yes — there is no point telling the other doers
 * that a deadline MIGHT move. The new date is in the body because that, and the
 * reason, are the whole of what the decision turns on.
 */
async function extensionAsked(task, update, actor, request) {
  const to = recipients([task.createdBy], actor?._id);
  if (!to.length) return;
  await notifyMany(to, {
    type: 'task',
    audience: 'admin',
    title: `${nameOf(actor)} needs longer on ${taskName(task)}`,
    body: `Asking for ${fmtDateTime(request.toDate)} — ${String(request.reason || '').slice(0, 140)}`,
    link: adminTaskLink(task._id),
    data: { taskId: String(task._id), extension: String(request._id) },
  });
}

/** …and the answer, which goes back DOWN to whoever asked. */
async function extensionDecided(task, update, actor, request) {
  const to = recipients([request.requestedBy], actor?._id);
  if (!to.length) return;
  const yes = request.status === 'APPROVED';
  await notifyMany(to, {
    type: 'task',
    audience: 'employee',
    title: yes
      ? `More time granted on ${taskName(task)}`
      : `No extra time on ${taskName(task)}`,
    body: yes
      ? `New deadline: ${fmtDateTime(request.toDate)}.${request.decisionNote ? ` ${String(request.decisionNote).slice(0, 120)}` : ''}`
      : (String(request.decisionNote || '').slice(0, 160) || 'The deadline stands.'),
    link: employeeTaskLink(task._id),
    data: { taskId: String(task._id), extension: String(request._id), approved: yes },
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
  setOnYourBehalf,
  statusMoved,
  accepted,
  declined,
  delegated,
  transferred,
  taskSplit,
  pieceClaimed,
  progressSet,
  extensionAsked,
  extensionDecided,
  commented,
  edited,
  reminder,
  digest,
};
