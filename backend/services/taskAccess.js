/**
 * Who may hand work to whom, and who may see it afterwards.
 *
 * REWRITTEN 2026-09-21. Two questions live here, and they are the two the rest
 * of the module refuses to answer for itself.
 *
 * ── 1. DIRECTION ────────────────────────────────────────────────────────────
 *
 * Work travels DOWN the reporting line or ACROSS it. It does not travel up.
 *
 *   DOWN   to your reports, direct or indirect      → a TASK
 *   PEER   to somebody at your own level            → a TASK
 *   UP     to your manager, or anyone senior to you → a REQUEST, not a task
 *
 * The reasoning is not hierarchy for its own sake. A task is SCORED: it lands
 * in somebody's completion rate, their In Time / Delayed split and their
 * points. If a junior could set one on their manager, the manager's performance
 * figures would be partly written by the people reporting to them, and the
 * honest response would be to stop using the module. But juniors genuinely do
 * need things from above — the April figures, an approval, a decision — and
 * having no way to ask for them is how a portal ends up with a task called
 * "Sir please send data". So the upward ask is a first-class row with the same
 * feed, the same voice notes and the same three states, and it is simply not
 * counted as work the senior was set. User decision, 2026-09-21.
 *
 * HOW SENIORITY IS DECIDED. Two tests, cheapest first:
 *   a) Is the target anywhere in the actor's own management chain? Then UP —
 *      this is the common case and needs no tree.
 *   b) Otherwise compare DEPTH: how many steps each of them sits below the top
 *      of the reporting tree. Strictly shallower means senior, so a clerk in
 *      Sales cannot set a task on the Head of Accounts, who is in nobody's
 *      chain but theirs.
 * When depth cannot be established for either party — the reporting line is
 * incomplete, which it is for real people in every HRMS — the answer is PEER
 * and the task is allowed. A missing manager must not silently stop somebody
 * working; the chain test above still catches the case that actually matters.
 *
 * WHO IS EXEMPT. An admin (`tasks.manage`), a CEO/MD and a SuperAdmin may
 * assign to anyone: they ARE the top of the tree, and every direction from
 * there is down.
 *
 * ── 2. VISIBILITY ───────────────────────────────────────────────────────────
 *
 * You see a task if you are on it, you set it, or you were kept in the loop —
 * plus, if you hold `tasks.manage`, everything inside your company wall. That
 * is the whole rule; there is no per-department grant and no separate "my
 * team's tasks" capability, because a manager is already `createdBy` on the
 * work they set and in the loop on the work their people set each other.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const { hasPermission } = require('../middleware/authMiddleware');
const { companyScopeFilter, viewerCompanyScope } = require('../utils/employeeScope');
const { KIND_TASK, KIND_REQUEST } = require('../config/tasks');

const MAX_CHAIN = 20; // cycle guard, same depth the leave ladder uses

/** Roles that sit above the reporting tree rather than in it. */
const TOP_ROLES = ['SuperAdmin', 'CEO', 'MD'];

// ===== The reporting tree =====

/**
 * Every profile's manager, as one map, cached for a minute.
 *
 * Direction is asked once per assignee on every assign — a five-person task is
 * five questions — and each answer walks a chain. One collection scan a minute
 * is cheaper than the round trips, and the reporting line does not change
 * between two clicks. Deliberately NOT a permanent cache: an org change should
 * take effect within the minute, not on the next deploy.
 */
let treeCache = { at: 0, managerOf: null };
const TREE_TTL_MS = 60 * 1000;

async function reportingTree() {
  if (treeCache.managerOf && Date.now() - treeCache.at < TREE_TTL_MS) return treeCache.managerOf;
  const rows = await EmployeeProfile.find({ reportingManager: { $ne: null } })
    .select('user reportingManager')
    .lean();
  const managerOf = new Map();
  for (const r of rows) {
    if (r.user && r.reportingManager) managerOf.set(String(r.user), String(r.reportingManager));
  }
  treeCache = { at: Date.now(), managerOf };
  return managerOf;
}

/** Drop the cache — called when a reporting line is edited. */
function invalidateTree() {
  treeCache = { at: 0, managerOf: null };
}

/** The ids above `userId`, nearest first. */
async function chainAbove(userId) {
  const managerOf = await reportingTree();
  const out = [];
  const seen = new Set([String(userId)]);
  let cur = managerOf.get(String(userId));
  let depth = 0;
  while (cur && depth < MAX_CHAIN) {
    if (seen.has(cur)) break; // a cycle in the data must not hang the request
    seen.add(cur);
    out.push(cur);
    cur = managerOf.get(cur);
    depth += 1;
  }
  return out;
}

/**
 * How far below the top of the tree somebody sits. 0 = no manager recorded.
 * Null is never returned: an unmanaged person is treated as the top, which is
 * true of the people who actually have no manager and harmless for the ones
 * whose line is simply not filled in (they then come out PEER — see above).
 */
async function depthOf(userId) {
  return (await chainAbove(userId)).length;
}

// ===== Direction =====

/**
 * Which way work would be travelling from `actorId` to `targetId`.
 * @returns {Promise<'DOWN'|'PEER'|'UP'|'SELF'>}
 */
async function directionOf(actorId, targetId) {
  const a = String(actorId || '');
  const b = String(targetId || '');
  if (!a || !b) return 'PEER';
  if (a === b) return 'SELF';

  // (a) Is the target in the actor's own chain? The case that matters most,
  // and the one a depth comparison alone would get wrong in a flat org.
  const above = await chainAbove(a);
  if (above.includes(b)) return 'UP';

  // Is the actor in the TARGET's chain? Then the target reports to them,
  // however many rungs down.
  const targetAbove = await chainAbove(b);
  if (targetAbove.includes(a)) return 'DOWN';

  // (b) Different branches: compare seniority by depth.
  const [da, db] = [above.length, targetAbove.length];
  if (db < da) return 'UP';
  if (db > da) return 'DOWN';
  return 'PEER';
}

/** May this person assign without the direction rule applying at all? */
function isTopOfTree(user) {
  return Boolean(
    user
    && (TOP_ROLES.includes(user.role) || hasPermission(user, 'tasks.manage'))
  );
}

/**
 * What kind of row `actor` may create for each of `targetIds`.
 *
 * Returns the kind everybody agrees on, or throws when the selection is
 * INCONSISTENT — one task cannot be a downward instruction to one person and
 * an upward question to another, and silently splitting it into two rows would
 * produce a task nobody remembers creating.
 *
 * @returns {Promise<{kind:string, directions:Object<string,string>}>}
 */
async function resolveAssignmentKind(actor, targetIds, requested = null) {
  const ids = [...new Set((targetIds || []).map(String))].filter(Boolean);
  if (!ids.length) {
    const err = new Error('Choose at least one person for this task.');
    err.status = 400;
    throw err;
  }

  // The top of the tree assigns downward by definition.
  if (isTopOfTree(actor)) {
    return {
      kind: requested === KIND_REQUEST ? KIND_REQUEST : KIND_TASK,
      directions: Object.fromEntries(ids.map((id) => [id, 'DOWN'])),
    };
  }

  const directions = {};
  for (const id of ids) directions[id] = await directionOf(actor._id, id);

  const ups = ids.filter((id) => directions[id] === 'UP');

  if (ups.length && ups.length !== ids.length) {
    const err = new Error(
      'Pick either people you can set work for, or people you want to ask — not both on one row. '
      + 'Raise the upward ones as a separate request.'
    );
    err.status = 400;
    throw err;
  }

  // Everybody is above the actor: this is a request whether they said so or not.
  if (ups.length) return { kind: KIND_REQUEST, directions };

  // Nobody is above them. They may still deliberately raise a request sideways
  // or downward ("can you get me X") — asking is never forbidden.
  return { kind: requested === KIND_REQUEST ? KIND_REQUEST : KIND_TASK, directions };
}

/**
 * The people this caller may put on a TASK (as opposed to a request).
 * Used to narrow the assign form's picker, so an impossible selection is not
 * offered in the first place — the server still enforces it either way.
 */
async function assignableUserIds(req, candidateIds) {
  if (isTopOfTree(req.user)) return candidateIds.map(String);
  const out = [];
  for (const id of candidateIds) {
    const dir = await directionOf(req.user._id, id);
    if (dir !== 'UP') out.push(String(id));
  }
  return out;
}

/** The people this caller may raise a REQUEST with — their management chain. */
async function requestableUserIds(req) {
  const above = await chainAbove(req.user._id);
  if (above.length) return above;
  // Nobody above them in the data: fall back to the company's executives, so a
  // person whose reporting line is blank can still ask somebody.
  const scope = await viewerCompanyScope(req);
  const filter = { isActive: true, role: { $in: ['CEO', 'MD'] } };
  if (scope?.length) filter.company = { $in: scope };
  const execs = await User.find(filter).select('_id').lean();
  return execs.map((u) => String(u._id));
}

// ===== Visibility =====

/** Does this caller see everything inside the wall? */
function seesEverything(user) {
  return hasPermission(user, 'tasks.manage');
}

/**
 * The Mongo filter for "tasks this caller may see", before any UI filter.
 *
 * @param {import('express').Request} req
 * @param {'mine'|'delegated'|'loop'|'all'} [scope]
 */
async function visibleFilter(req, scope = 'all') {
  const me = req.user._id;
  const mine = { $or: [{ assignedTo: me }, { 'assignees.user': me }] };

  let base;
  if (scope === 'mine') {
    // "Mine" includes a task I am on only for ONE SUBTASK — that piece is
    // genuinely mine to do, and a list that hid it would be a list of work
    // nobody could find.
    base = { $or: [{ assignedTo: me }, { 'assignees.user': me }, { 'subtasks.assignee': me }] };
  } else if (scope === 'delegated') {
    // What I handed out — as the assigner, AND anything I passed on by
    // delegating it. I am no longer doing it but I am still answerable for it.
    base = { $or: [{ createdBy: me }, { 'delegations.from': me }] };
  } else if (scope === 'loop') {
    base = { loopUsers: me };
  } else if (seesEverything(req.user)) {
    base = {};
  } else {
    base = {
      $or: [
        { assignedTo: me }, { 'assignees.user': me }, { createdBy: me }, { loopUsers: me },
        // Somebody who owns a subtask sees the parent; somebody who once owned
        // the whole thing keeps seeing it after delegating it on.
        { 'subtasks.assignee': me }, { originalAssignees: me },
      ],
    };
  }

  const filter = { archived: { $ne: true }, ...base };

  // The company wall. `tasks.manage` widens WHOSE tasks you see, never WHICH
  // COMPANY'S — that is a separate wall and it applies to everybody.
  const companyFilter = await companyScopeFilter(req);
  if (companyFilter) {
    // A task whose company was never stamped (pre-rework rows) stays visible to
    // the people on it rather than vanishing behind a wall it predates.
    return { $and: [filter, { $or: [companyFilter, { company: null }] }] };
  }
  return filter;
}

/** May this caller open this task at all? */
function canSee(user, task) {
  if (!task) return false;
  if (seesEverything(user)) return true;
  const id = String(user._id);
  return (
    String(task.createdBy?._id || task.createdBy || '') === id
    || (task.assignees || []).some((a) => String(a.user?._id || a.user) === id)
    || String(task.assignedTo?._id || task.assignedTo || '') === id
    || (task.loopUsers || []).some((u) => String(u?._id || u) === id)
    // A subtask assigned to somebody who is not on the task would otherwise be
    // invisible to the only person who can do it.
    || (task.subtasks || []).some((st) => String(st.assignee?._id || st.assignee || '') === id)
    // Delegating a task on does not stop you following it.
    || (task.originalAssignees || []).some((u) => String(u?._id || u) === id)
  );
}

/**
 * This caller's standing ON this task, in the vocabulary config/tasks uses for
 * transitions. An admin counts as an assigner — they can act on anything —
 * but being the doer wins, because a manager working their own task should get
 * the doer's buttons rather than the overseer's.
 */
function actorRoleOn(user, task) {
  if (!task) return null;
  const id = String(user._id);
  if ((task.assignees || []).some((a) => String(a.user?._id || a.user) === id)) return 'doer';
  if (String(task.createdBy?._id || task.createdBy || '') === id) return 'assigner';
  if (seesEverything(user)) return 'assigner';
  return null;
}

/** May this caller edit the task's own fields (title, deadline, points)? */
function canEdit(user, task) {
  return actorRoleOn(user, task) === 'assigner';
}

/**
 * May this caller remove it? The person who set it, or an admin.
 *
 * A SuperAdmin may remove ANY task, whoever set it (user decision, 2026-09-21)
 * — `seesEverything` already covers them, and the role check below is what
 * makes that explicit rather than incidental to holding `tasks.manage`.
 */
function canDelete(user, task) {
  return (
    String(task.createdBy?._id || task.createdBy || '') === String(user._id)
    || user.role === 'SuperAdmin'
    || seesEverything(user)
  );
}

/**
 * May this caller destroy it for good, rather than archiving it?
 *
 * SuperAdmin alone. Ordinary removal ARCHIVES — the row keeps its feed, its
 * files and any points it credited, and simply stops appearing. A purge is for
 * genuine rubbish (a test row, a duplicate) and is refused by the controller
 * once points have been credited against it, because the IncentiveCredit would
 * outlive the only record of what it was for.
 */
function canPurge(user) {
  return user?.role === 'SuperAdmin';
}

/**
 * The buttons a client should draw, computed on the SERVER.
 *
 * Both clients used to work this out themselves from the status and the user's
 * id, in two places, with two sets of bugs. The task detail response now simply
 * says what may be done, and the web page and the phone draw what they are
 * told — the pattern the mobile port already settled on.
 */
function capabilitiesFor(user, task) {
  const role = actorRoleOn(user, task);
  const { TRANSITIONS, ACCEPTANCE, STATUS, isTerminal: terminal } = require('../config/tasks');
  const moves = (TRANSITIONS[task.status] || [])
    .filter((t) => role && t.by.includes(role))
    .map((t) => ({ to: t.to, note: Boolean(t.note) }));

  // The caller's OWN row, which is what accept / decline / delegate act on.
  const mine = (task.assignees || []).find(
    (a) => String(a.user?._id || a.user) === String(user._id)
  ) || null;
  const open = !terminal(task.status);

  return {
    role,
    canComment: Boolean(role) || canSee(user, task),
    canEdit: canEdit(user, task),
    canDelete: canDelete(user, task),
    canPurge: canPurge(user),
    transitions: moves,

    // ===== Accept / decline / delegate — the doer's three answers =====
    // Only ever offered to somebody who actually HAS the task: an assigner
    // cannot accept on a doer's behalf, which would make acceptance worthless.
    canAccept: Boolean(mine) && open && mine.acceptance === ACCEPTANCE.AWAITING,
    canDecline: Boolean(mine) && open && mine.acceptance !== ACCEPTANCE.REJECTED
      && mine.status !== STATUS.COMPLETED,
    // Delegating is passing YOUR OWN piece on, so an assigner who is not also a
    // doer has nothing to delegate — they reassign instead (PATCH /:id).
    canDelegate: Boolean(mine) && open && mine.status !== STATUS.COMPLETED,
    myAcceptance: mine ? mine.acceptance : null,

    // ===== Subtasks =====
    // Anybody on the task may split it up, not just whoever set it: the person
    // doing the work is the one who knows what the pieces are.
    canAddSubtasks: Boolean(role) && open,
    // Ticking one is decided PER SUBTASK (an assigned piece is its owner's),
    // so this only says whether the person may tick ANYTHING at all.
    //
    // Computed from the array rather than through the document's `ownsSubtask`
    // method, because the LIST hands this function `.lean()` rows which have no
    // methods — and `undefined?.()` would silently answer "no" to the one
    // person who owns the piece.
    canTickSubtasks: Boolean(role) || ownsAnySubtask(user, task),
  };
}

/** Does this user own at least one piece of the task? Lean-safe. */
function ownsAnySubtask(user, task) {
  const id = String(user._id);
  return (task.subtasks || []).some(
    (st) => String(st.assignee?._id || st.assignee || '') === id
  );
}

/**
 * May this caller tick THIS subtask?
 *
 * An unassigned subtask is open to everybody on the task — the user's "any
 * assignee can do any subtask". An assigned one belongs to its owner, and to
 * whoever set the task (who has to be able to close out a piece when the owner
 * has left or gone quiet).
 */
function canTickSubtask(user, task, subtask) {
  const id = String(user._id);
  if (!subtask) return false;
  if (subtask.assignee) {
    return String(subtask.assignee._id || subtask.assignee) === id
      || String(task.createdBy?._id || task.createdBy || '') === id
      || seesEverything(user);
  }
  return Boolean(actorRoleOn(user, task));
}

/** A guard that throws the 403 rather than making every handler write it. */
function assertCanSee(user, task) {
  if (!canSee(user, task)) {
    const err = new Error('That task is not yours to see.');
    err.status = 403;
    throw err;
  }
}

function assertCanEdit(user, task) {
  if (!canEdit(user, task)) {
    const err = new Error('Only the person who set this task can change it.');
    err.status = 403;
    throw err;
  }
}

module.exports = {
  TOP_ROLES,
  reportingTree,
  invalidateTree,
  chainAbove,
  depthOf,
  directionOf,
  isTopOfTree,
  resolveAssignmentKind,
  assignableUserIds,
  requestableUserIds,
  seesEverything,
  visibleFilter,
  canSee,
  canEdit,
  canDelete,
  canPurge,
  canTickSubtask,
  actorRoleOn,
  capabilitiesFor,
  assertCanSee,
  assertCanEdit,
  isValidId: (v) => mongoose.Types.ObjectId.isValid(v),
};
