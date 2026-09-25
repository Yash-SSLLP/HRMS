/**
 * Who may hand work to whom, and who may see it afterwards.
 *
 * REWRITTEN 2026-09-21. Two questions live here, and they are the two the rest
 * of the module refuses to answer for itself.
 *
 * ── 1. DIRECTION ────────────────────────────────────────────────────────────
 *
 * RETIRED AS A RULE ON 2026-09-25 — *"everyone can assign task to anyone"*.
 * Nothing below refuses an assignment or turns one into a request any more
 * (see resolveAssignmentKind). The reporting tree survives because the pickers
 * still open on the people who matter to you first — your team, then your line
 * — and search everybody else. What follows is the rule as it stood, kept
 * because `directionOf` and the tree walks it describes are still used.
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
const EmployeeProfile = require('../models/EmployeeProfile');
const { hasPermission } = require('../middleware/authMiddleware');
const { companyScopeFilter } = require('../utils/employeeScope');
const { KIND_TASK } = require('../config/tasks');

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
let treeCache = { at: 0, managerOf: null, reportsOf: null };
const TREE_TTL_MS = 60 * 1000;

/**
 * Both directions, built from ONE scan.
 *
 * `managerOf` answers "who is above me" and is what direction has always
 * needed. `reportsOf` — added 2026-09-22 — answers "who is below me", which is
 * what every person dropdown in the module now opens with: *"only show the team
 * member for manager and for CEO and MD show Manager who are under them"*.
 * Inverting the map afterwards would mean a second pass over the same rows, so
 * both are filled in the same loop and cached together.
 */
async function buildTree() {
  if (treeCache.managerOf && Date.now() - treeCache.at < TREE_TTL_MS) return treeCache;
  const rows = await EmployeeProfile.find({ reportingManager: { $ne: null } })
    .select('user reportingManager')
    .lean();
  const managerOf = new Map();
  const reportsOf = new Map();
  for (const r of rows) {
    if (!r.user || !r.reportingManager) continue;
    const u = String(r.user);
    const m = String(r.reportingManager);
    managerOf.set(u, m);
    if (!reportsOf.has(m)) reportsOf.set(m, []);
    reportsOf.get(m).push(u);
  }
  treeCache = { at: Date.now(), managerOf, reportsOf };
  return treeCache;
}

async function reportingTree() {
  return (await buildTree()).managerOf;
}

/** Drop the cache — called when a reporting line is edited. */
function invalidateTree() {
  treeCache = { at: 0, managerOf: null, reportsOf: null };
}

/**
 * Everybody under `userId` — direct reports, then everybody under them.
 *
 * Breadth-first, so `direct` is the first rung and `indirect` is the rest in
 * the order you would read an org chart. Cycle-guarded on a `seen` set rather
 * than a depth counter: the data can and does contain a loop, and a loop here
 * would hang a dropdown rather than merely mis-sort it.
 *
 * @returns {Promise<{direct: string[], indirect: string[], all: Set<string>}>}
 */
async function teamOf(userId) {
  const { reportsOf } = await buildTree();
  const root = String(userId || '');
  const direct = [...(reportsOf.get(root) || [])];
  const seen = new Set([root, ...direct]);
  const indirect = [];

  let frontier = direct;
  let depth = 0;
  while (frontier.length && depth < MAX_CHAIN) {
    const next = [];
    for (const id of frontier) {
      for (const child of reportsOf.get(id) || []) {
        if (seen.has(child)) continue;
        seen.add(child);
        indirect.push(child);
        next.push(child);
      }
    }
    frontier = next;
    depth += 1;
  }

  seen.delete(root);
  return { direct, indirect, all: seen };
}

/**
 * How `targetId` stands to `actorId`, in the words a picker groups by.
 *
 *   self · direct · indirect   — my team, and what a dropdown opens with
 *   manager · chain            — my line manager, and everybody above them
 *   peer                       — everybody else
 *
 * This is deliberately NOT the same question as `directionOf`. Direction
 * decides what may be CREATED (a task or a request) and falls back to PEER
 * whenever the data cannot say; relation decides what is SHOWN FIRST, and
 * "somewhere else in the company" is a perfectly good answer for it.
 */
async function relationTo(actorId, targetId) {
  const a = String(actorId || '');
  const b = String(targetId || '');
  if (!a || !b) return 'peer';
  if (a === b) return 'self';

  const { managerOf } = await buildTree();
  if (managerOf.get(b) === a) return 'direct';

  const above = await chainAbove(b);
  if (above.includes(a)) return 'indirect';

  const myChain = await chainAbove(a);
  if (myChain[0] === b) return 'manager';
  if (myChain.includes(b)) return 'chain';

  return 'peer';
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
 * What kind of row `actor` may create for `targetIds`.
 *
 * ALWAYS A TASK, since 2026-09-25. The user's words: *"everyone can assign task
 * to anyone"* and *"remove the option for ask"*. Until then an upward
 * assignment silently became a REQUEST — unscored, no points, filed under its
 * own tab — and a selection mixing seniors and juniors was refused outright.
 * Both rules are gone: a task set on your manager is a task like any other.
 *
 * `requested` is deliberately IGNORED. An Android build from before this change
 * still has an "Ask" button that posts `kind: 'REQUEST'`; honouring it would
 * mint a row in a pile the current clients no longer show. It becomes the task
 * it now is instead. The two REQUEST rows already in the data are listed with
 * the tasks (taskController.buildQuery), so nothing already raised goes
 * missing either.
 *
 * `directionOf` is kept: the pickers still use the reporting tree to decide who
 * to show FIRST (annotatePeople), just never to refuse anybody.
 *
 * @returns {Promise<{kind:string}>}
 */
// eslint-disable-next-line no-unused-vars
async function resolveAssignmentKind(actor, targetIds, requested = null) {
  const ids = [...new Set((targetIds || []).map(String))].filter(Boolean);
  if (!ids.length) {
    const err = new Error('Choose at least one person for this task.');
    err.status = 400;
    throw err;
  }
  return { kind: KIND_TASK };
}

/**
 * The people this caller may put on a task — everybody offered, since
 * 2026-09-25 (see resolveAssignmentKind). Kept as a function because the meta
 * response still stamps `canAssign` on every person, and an older app greys
 * anybody it reads `false` on as "ask only".
 */
async function assignableUserIds(req, candidateIds) {
  return candidateIds.map(String);
}

/**
 * Roles that stand in for "my team" when the reporting tree has nothing to say.
 *
 * A CEO or MD almost never appears in `EmployeeProfile.reportingManager` — they
 * have no employee profile at all in this portal (see the celebrations module,
 * which had to solve the same absence). So the tree hands them an empty team,
 * and a picker that opens empty for the two people who assign the most work is
 * the picker not working. The brief says what they should see instead: *"for
 * CEO and MD show Manager who are under them"*.
 */
const MANAGER_ROLES = ['Manager', 'HRManager', 'AccountsManager'];

/**
 * Tag every person in a picker with where they stand — the ONE answer both the
 * web picker and the app's picker group by, computed once on the server.
 *
 * Every dropdown in the module then follows the same rule without re-deriving
 * anything: with an empty search box it shows the people most likely to be
 * wanted — yourself, `direct`, `indirect`, your line, your department — and
 * typing searches the lot. Nobody is greyed any more: since 2026-09-25 anybody
 * may be given a task. See docs/task-module.md §3a.
 *
 * @param {import('express').Request} req
 * @param {Array} people - lean User rows, each with `_id` and `role`
 * @returns {Promise<{people: Array, team: {direct: string[], indirect: string[]}, hasTeam: boolean}>}
 */
async function annotatePeople(req, people = []) {
  const me = String(req.user._id);
  const { direct, indirect } = await teamOf(me);
  const directSet = new Set(direct);
  const indirectSet = new Set(indirect);

  // The stand-in, for somebody the tree puts nobody under. Only ever WIDENS the
  // first screen of a dropdown — who may be assigned is everybody either way.
  let fallback = null;
  if (!direct.length && !indirect.length && isTopOfTree(req.user)) {
    fallback = new Set(
      people.filter((p) => MANAGER_ROLES.includes(p.role)).map((p) => String(p._id))
    );
  }

  const annotated = [];
  for (const p of people) {
    const id = String(p._id);
    let relation;
    if (id === me) relation = 'self';
    else if (directSet.has(id)) relation = 'direct';
    else if (indirectSet.has(id)) relation = 'indirect';
    else if (fallback?.has(id)) relation = 'direct';
    else relation = await relationTo(me, id);

    // No `direction` any more: it only ever decided task-or-request, and every
    // assignment is a task now (resolveAssignmentKind).
    annotated.push({ ...p, relation });
  }

  return {
    people: annotated,
    team: {
      direct: annotated.filter((p) => p.relation === 'direct').map((p) => String(p._id)),
      indirect: annotated.filter((p) => p.relation === 'indirect').map((p) => String(p._id)),
    },
    hasTeam: annotated.some((p) => p.relation === 'direct' || p.relation === 'indirect'),
  };
}

/**
 * The ids this caller's team covers — used to default the `openTo` pool of a
 * piece nobody has been named for, so "anybody on my team can pick this up"
 * needs no typing at all.
 */
async function defaultOpenTo(userId) {
  const { direct } = await teamOf(userId);
  return direct;
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
    // "Mine" includes a PIECE that is open to me but not yet claimed. It is
    // work I may pick up, and a list that hid it would be a list nobody could
    // find the offer in — which is the whole of the brief's *"they can pick the
    // task"*. The row draws a Claim button instead of the usual ones.
    base = { $or: [{ assignedTo: me }, { 'assignees.user': me }, { openTo: me }] };
  } else if (scope === 'delegated') {
    // What I handed out — as the assigner, AND anything I passed on by
    // delegating it. I am no longer doing it but I am still answerable for it.
    // What I handed out — as the person who SET it, as anybody who passed it
    // on, and (since 2026-09-22) as whoever it now waits on. A manager who
    // delegated a CEO's task is no longer doing it and is not its creator, but
    // they are the one who has to sign it off, so it belongs on their desk.
    base = { $or: [{ createdBy: me }, { approver: me }, { 'delegations.from': me }] };
  } else if (scope === 'loop') {
    base = { loopUsers: me };
  } else if (seesEverything(req.user)) {
    base = {};
  } else {
    base = {
      $or: [
        { assignedTo: me }, { 'assignees.user': me }, { createdBy: me }, { approver: me },
        { loopUsers: me },
        // A piece offered to me; and somebody who once owned the whole thing
        // keeps seeing it after delegating it on.
        { openTo: me }, { originalAssignees: me },
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
    || String(task.approver?._id || task.approver || '') === id
    || (task.loopUsers || []).some((u) => String(u?._id || u) === id)
    // A piece offered to me and not yet claimed would otherwise be invisible to
    // the only people who are allowed to take it.
    || (task.openTo || []).some((u) => String(u?._id || u) === id)
    // Delegating a task on does not stop you following it.
    || (task.originalAssignees || []).some((u) => String(u?._id || u) === id)
  );
}

/**
 * May this caller open a PIECE they have no direct claim on?
 *
 * Yes if they can see its parent. A manager splits the CEO's task five ways;
 * the CEO is on none of the five and is in nobody's `openTo`, but "how is my
 * task going" has to be answerable — so the parent's detail response carries
 * its children, and this is the check behind it. Deliberately one extra READ
 * rather than a `parentViewers` array copied onto every child, which would be a
 * second list of people to keep in step and would go stale the first time
 * somebody was added to the parent.
 */
async function canSeeThroughParent(user, task) {
  if (!task?.parentTask) return false;
  const Task = require('../models/Task');
  const parent = await Task.findById(task.parentTask)
    .select('createdBy assignees assignedTo loopUsers openTo originalAssignees company')
    .lean();
  return parent ? canSee(user, parent) : false;
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
  // The APPROVER counts too (2026-09-22). After a delegation they are the
  // person the submission is actually waiting on, and if they were not an
  // assigner here they could be notified of a job they had no button for.
  if (String(task.approver?._id || task.approver || '') === id) return 'assigner';
  if (seesEverything(user)) return 'assigner';
  return null;
}

/** Whoever signs this off. The approver if one is set; otherwise its setter. */
function approverOf(task) {
  return task?.approver || task?.createdBy || null;
}

/**
 * May this caller hand the task to somebody else outright?
 *
 * A transfer corrects a MISTAKE — *"if the task is assigned to wrong user"* —
 * so the two people who can see the mistake are the two who may fix it: whoever
 * set it, and whoever it landed on. (An admin, as always, can do either.)
 */
function canTransfer(user, task) {
  if (!task) return false;
  const id = String(user._id);
  return String(task.createdBy?._id || task.createdBy || '') === id
    || String(task.approver?._id || task.approver || '') === id
    || (task.assignees || []).some((a) => String(a.user?._id || a.user) === id)
    || seesEverything(user);
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
  const {
    TRANSITIONS, ACCEPTANCE, STATUS, EXTENSION_STATUS, MAX_SPLIT_DEPTH,
    KIND_TASK, isTerminal: terminal, effectiveTarget,
  } = require('../config/tasks');
  const role = actorRoleOn(user, task);
  const id = String(user._id);

  // The caller's OWN row, which is what accept / decline / progress act on.
  const mine = (task.assignees || []).find((a) => String(a.user?._id || a.user) === id) || null;
  const open = !terminal(task.status);
  const isSetter = String(task.createdBy?._id || task.createdBy || '') === id;
  const isPiece = Boolean(task.parentTask);
  const unclaimed = isPiece && !(task.assignees || []).length;
  const offeredToMe = (task.openTo || []).some((u) => String(u?._id || u) === id);

  /**
   * The moves, AFTER the review rule.
   *
   * A doer's Complete is redirected to SUBMITTED by the engine
   * (config/tasks.effectiveTarget), so offering both here would draw two
   * buttons that do the same thing and label one of them wrongly. The list is
   * mapped through the same function the engine uses and de-duplicated, which
   * is the only way the button a person presses and the thing that happens
   * cannot come apart.
   */
  const seen = new Set();
  const moves = [];
  for (const t of TRANSITIONS[task.status] || []) {
    if (!role || !t.by.includes(role)) continue;
    const to = effectiveTarget(task, role, t.to, user._id);
    if (seen.has(to) || to === task.status) continue;
    seen.add(to);
    moves.push({ to, note: Boolean(t.note) });
  }

  const canApprove = task.status === STATUS.SUBMITTED && role === 'assigner';

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

    // ===== Submit · approve · send back (2026-09-22) =====
    // Submitting is the doer's; both answers to it are the assigner's. They are
    // named separately from `transitions` because the WORDS matter on a button
    // — "Approve" and "Send back" are not "mark completed" and "mark in
    // progress", even though that is what they do underneath.
    canSubmit: Boolean(mine) && open && task.status !== STATUS.SUBMITTED
      && mine.status !== STATUS.COMPLETED && task.requiresApproval !== false && !isSetter,
    canApprove,
    canReject: canApprove,
    canWithdraw: Boolean(mine) && task.status === STATUS.SUBMITTED,

    // ===== Progress =====
    // Only the person doing it may say how far along it is. An assigner who
    // could type it would be reporting on work they have not done.
    canSetProgress: Boolean(mine) && open && mine.status !== STATUS.COMPLETED,
    myProgress: mine ? (Number(mine.progress) || 0) : null,

    // ===== Splitting it into pieces =====
    // Anybody on the task may split it, not just whoever set it: the person
    // doing the work is the one who knows what the pieces are. Capped by depth
    // so a chain of pieces-of-pieces cannot run away.
    canSplit: Boolean(role) && open && task.kind === KIND_TASK
      && (Number(task.depth) || 0) < MAX_SPLIT_DEPTH - 1,
    // A piece nobody has been named for, offered to me.
    canClaim: unclaimed && open && (offeredToMe || seesEverything(user)),
    pointsBudget: Math.max(0, (Number(task.points) || 0) - (Number(task.distributedPoints) || 0)),

    // ===== Asking for more time =====
    // One un-answered request per person: a doer who could stack three would be
    // asking the same question three times, and the assigner would have to say
    // no to all of them.
    canRequestExtension: Boolean(mine) && open && Boolean(task.dueDate)
      && !(task.extensions || []).some(
        (e) => e.status === EXTENSION_STATUS.PENDING
          && String(e.requestedBy?._id || e.requestedBy) === id
      ),
    canDecideExtension: role === 'assigner'
      && (task.extensions || []).some((e) => e.status === EXTENSION_STATUS.PENDING),

    // ===== Handing it to the right person =====
    // Correcting a mis-assignment, which is NOT delegating: the person it comes
    // off drops out completely. See services/taskEngine.transferTask.
    canTransfer: canTransfer(user, task) && open,

    // ===== Retired, kept truthful for an un-updated Android build =====
    // It reads `can.canAddSubtasks` to decide whether to draw the split button
    // and `can.canTickSubtasks` to decide whether the pieces are interactive.
    // Both still mean what they meant; they simply drive child tasks now.
    canAddSubtasks: Boolean(role) && open && task.kind === KIND_TASK,
    canTickSubtasks: Boolean(role),
  };
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
  teamOf,
  relationTo,
  annotatePeople,
  defaultOpenTo,
  MANAGER_ROLES,
  isTopOfTree,
  resolveAssignmentKind,
  assignableUserIds,
  seesEverything,
  visibleFilter,
  canSee,
  canSeeThroughParent,
  approverOf,
  canTransfer,
  canEdit,
  canDelete,
  canPurge,
  actorRoleOn,
  capabilitiesFor,
  assertCanSee,
  assertCanEdit,
  isValidId: (v) => mongoose.Types.ObjectId.isValid(v),
};
