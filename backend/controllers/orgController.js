/**
 * Org controller — builds the read-only reporting-hierarchy org chart from
 * EmployeeProfile.reportingManager links, folding in profile-less CEO/MD
 * executives as top nodes, and guarding against manager cycles so the tree
 * always renders.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const Company = require('../models/Company');
const { hiddenUserIds } = require('../utils/visibility');
const { viewerCompanyScope } = require('../utils/employeeScope');
const { hasDeparted } = require('../utils/departed');

/**
 * How one branch is laid out, left to right (top to bottom on the phone).
 *
 * AN ARRANGED BRANCH KEEPS ITS ARRANGEMENT. `node.order` is the position a
 * SuperAdmin gave a card inside its OWN branch — resolved from
 * User.orgChartOrder, and only while the card is still in the branch it was
 * given for — so a card that has one always sits where it was put. A card
 * without one, somebody who joined after the branch was arranged, falls in
 * behind them under the default rules below rather than silently displacing
 * anyone. Two numbers from different branches are never compared: this only
 * ever sorts one sibling list at a time.
 *
 * THE DEFAULT, for a branch nobody has arranged: the executives bookend it —
 * CEO at the left end, MD at the right — then the people with no department,
 * then everybody else by name. The executive rule only bites at the top level,
 * which is the only place a CEO or MD appears.
 *
 * This used to live in the web page (`sortTree`), which left the phone showing
 * a different order for the same chart. It is one rule now, and it is here.
 */
const compareSiblings = (a, b) => {
  const ra = Number.isFinite(a.order) ? a.order : null;
  const rb = Number.isFinite(b.order) ? b.order : null;
  if (ra !== null || rb !== null) {
    if (ra === null) return 1; // unarranged cards go behind the arranged ones
    if (rb === null) return -1;
    if (ra !== rb) return ra - rb;
  }
  // -1 pulls to the left end, +1 pushes to the right end, 0 is everybody else.
  const end = (n) => (n.role === 'CEO' ? -1 : n.role === 'MD' ? 1 : 0);
  if (end(a) !== end(b)) return end(a) - end(b);
  const assigned = (n) => (n.department && n.department.trim() ? 1 : 0);
  if (assigned(a) !== assigned(b)) return assigned(a) - assigned(b);
  return (a.name || '').localeCompare(b.name || '');
};

/** Apply `compareSiblings` to a branch and to every branch beneath it. */
const sortBranch = (list) => {
  list.sort(compareSiblings);
  for (const n of list) if (n.reports?.length) sortBranch(n.reports);
  return list;
};

/**
 * Return the reporting hierarchy as a forest of nodes for the org-chart view.
 *
 * COMPANIES. Every node carries the company it belongs to, and `?company=<id>`
 * narrows the chart to one. With no parameter the chart spans every company,
 * which is the default the business asked for: one hierarchy, with the dropdown
 * as a filter rather than a thing you must choose before seeing anything.
 * Filtering to a company is a genuine re-root — somebody whose manager sits in
 * another company simply becomes a root here, which the existing
 * manager-not-in-set branch below already handles.
 *
 * SCOPING. A CEO/MD narrowed to certain companies (User.companies) sees only
 * those, wherever the request came from. This used to be missing entirely: the
 * chart applied `hiddenUserIds` alone, so a company-limited executive could
 * read every other company's people straight off it while the employee
 * directory correctly refused them.
 *
 * ORDER WITHIN A BRANCH. Cards that share a manager are drawn in the order a
 * SuperAdmin arranged them (User.orgChartOrder), and in the chart's own order
 * where nobody has — executives bookending the top row, then the people with no
 * department, then by name. See `compareSiblings` below. PUT /chart/order is
 * what arranges a branch.
 *
 * @route GET /api/org/chart
 * @param {string} [req.query.company] - Company id to narrow the chart to.
 * @returns {{roots: Object[], companies: Object[]}} each node
 *   {id, profileId, name, designation, department, companyId, companyName, role, managerId, order, reports[]}
 */
// GET /api/org/chart
// Builds a read-only reporting hierarchy from EmployeeProfile records.
// Each node is keyed by the profile's USER id and links to its manager via
// the profile's `reportingManager` (also a User id). Employees with no
// manager, or whose manager is not an employee in the set, surface as roots.
const orgChart = asyncHandler(async (req, res) => {
  const hidden = await hiddenUserIds(req.user);
  const filter = {};
  if (hidden.length) filter.user = { $nin: hidden };

  // What this viewer is allowed to see, then what they asked to see. The scope
  // is applied first and the request narrowed INTO it, so `?company=` can never
  // widen anybody past their own companies. This is no longer exec-only: every
  // non-Backend viewer (HR, managers, plain employees) is walled into their own
  // company; a viewer whose own profile has no company stays unrestricted.
  const scope = viewerCompanyScope(req);
  const asked = req.query.company;
  const askedValid = asked && mongoose.Types.ObjectId.isValid(asked) ? String(asked) : '';
  // `{ $in: [] }` matches NOTHING. Bare `company: null` would have been wrong
  // here: in Mongo that matches every employee with no company set, so a viewer
  // asking for a company they do not hold would have been handed the
  // unassigned people instead of an empty chart. Non-exec viewers DO also see
  // the no-company people on their unfiltered chart ($in with null).
  if (askedValid) {
    filter.company = scope && !scope.ids.includes(askedValid) ? { $in: [] } : askedValid;
  } else if (scope) {
    filter.company = { $in: scope.includeUnassigned ? [...scope.ids, null] : scope.ids };
  }

  const profiles = await EmployeeProfile.find(filter)
    .select('user reportingManager designation department company dateOfExit')
    .populate('user', 'firstName lastName email photo role isActive orgChartOrder')
    .populate('company', 'name')
    .lean();

  // Who each employee reports to, read off EVERY profile — including the ones
  // that do not become nodes below. This is what lets somebody who has left be
  // dropped without stranding their team: the people under them climb to that
  // person's OWN manager instead of falling to the top of the chart.
  const managerOfUser = new Map();
  for (const p of profiles) {
    if (!p.user) continue;
    managerOfUser.set(String(p.user._id), p.reportingManager ? String(p.reportingManager) : null);
  }

  // Build one node per employee, keyed by the user id. The stored positions are
  // collected alongside and applied further down, once every branch is settled.
  const savedOrder = new Map();
  const nodes = new Map();
  for (const p of profiles) {
    if (!p.user) continue; // skip orphaned profiles with no linked user
    // People who have left are not on the chart at all. `isActive` alone would
    // not be enough — a resignation leaves the login working through the notice
    // period — so the shared rule decides it (utils/departed).
    if (hasDeparted(p.user, p)) continue;
    const id = p.user._id.toString();
    const name = `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim();
    savedOrder.set(id, p.user.orgChartOrder || null);
    nodes.set(id, {
      id,
      profileId: p._id.toString(), // EmployeeProfile id — used by SuperAdmin to reassign the manager
      name,
      designation: p.designation || '',
      department: p.department || '',
      companyId: p.company ? String(p.company._id) : null,
      companyName: p.company?.name || '',
      hasPhoto: Boolean(p.user.photo),
      role: p.user.role,
      managerId: p.reportingManager ? p.reportingManager.toString() : null,
      // Filled in below, once the branch this card lands in is settled.
      order: null,
      reports: [],
    });
  }

  // CEO/MD are executives, NOT employees, so they have no EmployeeProfile — but
  // they still sit at the top of the reporting hierarchy (they approve leave and
  // people report up to them). Add them as profile-less nodes so the chart shows
  // them and they can be picked as a manager. profileId=null → the client treats
  // the node as read-only (you don't reassign whom the CEO reports to).
  const hiddenSet = new Set(hidden.map(String));
  const execs = await User.find({ role: { $in: ['CEO', 'MD'] }, isActive: true })
    .select('firstName lastName photo role companies orgChartOrder')
    .lean();
  // Which company an exec belongs to is their OWN assignment list, not a
  // profile they do not have. An exec with no list covers every company, so
  // they stay on the chart whatever is selected; a narrowed one appears only
  // for the companies they actually cover.
  const execCovers = (u) => {
    const own = Array.isArray(u.companies) ? u.companies.filter(Boolean).map(String) : [];
    if (own.length === 0) return true; // spans the whole group
    if (askedValid) return own.includes(askedValid);
    // A company-walled viewer only sees the executives who cover their company.
    if (scope) return own.some((c) => scope.ids.includes(c));
    return true;
  };
  for (const u of execs) {
    const id = u._id.toString();
    if (nodes.has(id) || hiddenSet.has(id)) continue;
    if (!execCovers(u)) continue;
    savedOrder.set(id, u.orgChartOrder || null);
    nodes.set(id, {
      id,
      profileId: null,
      name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      designation: u.role === 'MD' ? 'Managing Director' : 'Chief Executive Officer',
      department: '',
      // An executive spans the group rather than sitting inside one company.
      companyId: null,
      companyName: '',
      hasPhoto: Boolean(u.photo),
      role: u.role,
      managerId: null,
      order: null, // see the resolve pass below
      reports: [],
    });
  }

  // Climb past anyone who has left, so their team reports to whoever the leaver
  // reported to rather than appearing at the top of the chart as if they had no
  // manager at all. Depth- and cycle-guarded because a manager chain CAN be
  // circular — the guard further down exists for exactly that, and this walk
  // runs before it. A chain that ends nowhere (or leaves this viewer's company
  // wall) yields null, which is the same "root" answer as before.
  const liveManagerOf = (startUserId) => {
    const seen = new Set([startUserId]);
    let id = managerOfUser.get(startUserId) ?? null;
    let depth = 0;
    while (id && depth < 50) {
      if (seen.has(id)) return null; // cycle → treat as top level
      seen.add(id);
      if (nodes.has(id)) return id; // the first manager still on the chart
      id = managerOfUser.get(id) ?? null; // they left too → keep climbing
      depth += 1;
    }
    return null;
  };
  for (const node of nodes.values()) {
    if (!node.profileId) continue; // execs have no reporting line of their own
    node.managerId = liveManagerOf(node.id);
  }

  // NOW RESOLVE EACH CARD'S POSITION, and not a line earlier: a saved position
  // belongs to ONE branch (User.orgChartOrder.branch), and the branch a card
  // actually lands in is only settled by the walk above — somebody whose manager
  // has left climbs to a different one. A position given for a branch this card
  // is no longer in is simply not applied, which is how a reporting-line change
  // drops a stale arrangement without anything having to clean up after it.
  for (const node of nodes.values()) {
    const saved = savedOrder.get(node.id);
    node.order = saved && Number.isFinite(saved.index)
      && String(saved.branch || '') === String(node.managerId || '')
      ? saved.index
      : null;
  }

  // Link each node to its manager; collect roots.
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.managerId ? nodes.get(node.managerId) : null;
    if (parent && parent.id !== node.id) {
      parent.reports.push(node);
    } else {
      // managerId is null, manager not in set, or self-reference -> root
      roots.push(node);
    }
  }

  // Cycle guard: prune any node already reachable from a root so a back-edge
  // (A -> B -> A) cannot cause infinite nesting. We rebuild `reports` via DFS,
  // tracking visited ids; nodes seen twice are dropped from the second branch.
  const visited = new Set();
  const safe = (node) => {
    if (visited.has(node.id)) return null;
    visited.add(node.id);
    node.reports = node.reports
      .map((child) => safe(child))
      .filter((child) => child !== null);
    return node;
  };
  const safeRoots = roots.map((r) => safe(r)).filter((r) => r !== null);

  // Any node never reached is trapped in a manager cycle with no external root
  // (e.g. A reports to B and B reports to A). Surface such nodes as roots so the
  // whole chart never silently disappears when someone sets a circular manager.
  for (const node of nodes.values()) {
    if (!visited.has(node.id)) {
      const r = safe(node);
      if (r) safeRoots.push(r);
    }
  }

  // LAY EACH BRANCH OUT. Everything above is the hierarchy as the data has it;
  // this is where it is put in order — the top row and every branch under it,
  // by the one rule in compareSiblings. It runs here, after the cycle guard has
  // finished rebuilding `reports`, so nothing it sorts can still change.
  sortBranch(safeRoots);

  // The dropdown's options travel with the chart, so the client needs one call.
  // Narrowed to what this viewer may pick, for the same reason as above.
  const companyQuery = scope ? { _id: { $in: scope.ids } } : {};
  const companies = await Company.find(companyQuery).select('name code').sort({ name: 1 }).lean();

  res.json({
    roots: safeRoots,
    companies: companies.map((c) => ({ _id: String(c._id), name: c.name, code: c.code || null })),
    company: askedValid || '',
  });
});

/**
 * Arrange one branch: the left-to-right order its cards are drawn in.
 *
 * The whole branch is sent, not the one card that moved, and every id in it is
 * given a position — see User.orgChartOrder for why a half-arranged branch is
 * not a thing. Nothing about the hierarchy changes here: this is where the cards
 * sit beside each other, never who reports to whom.
 *
 * `branch` is the manager they all report to, or null for the top row, and it is
 * STORED WITH each position: the chart only honours a position while the person
 * is still in the branch it was given for, so moving somebody under a new
 * manager drops their old place instead of carrying it into a team they have
 * just joined.
 *
 * A branch arranged while the chart is FILTERED to one company only carries
 * positions for the cards that were on screen. That is the honest outcome — the
 * operator arranged what they could see — and the cards they could not see keep
 * whatever they had, so they appear after the arranged ones on the full chart.
 *
 * @route PUT /api/org/chart/order  (SuperAdmin)
 * @param {string[]} req.body.order - user ids, in the order they should appear
 * @param {string|null} [req.body.branch] - the manager they share; null = top row
 * @returns {{branch: string|null, order: string[]}}
 */
const setChartOrder = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.order) ? req.body.order.map((x) => String(x)) : [];
  if (ids.length === 0 || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    res.status(400);
    throw new Error('Send the branch as a list of people, in the order they should appear.');
  }
  if (new Set(ids).size !== ids.length) {
    res.status(400);
    throw new Error('The same person appears twice in that branch.');
  }
  // An absent or empty `branch` is the TOP ROW — the one branch that genuinely
  // has no manager. A junk id is REFUSED rather than quietly read as the top
  // row: it could only come from a client bug, and storing it would make every
  // position in the branch unmatchable, so the arrangement would never appear
  // at all and nobody would know why.
  const asked = req.body.branch;
  const branch = asked && mongoose.Types.ObjectId.isValid(String(asked)) ? String(asked) : null;
  if (asked && !branch) {
    res.status(400);
    throw new Error('That is not a manager this branch could belong to.');
  }
  await User.bulkWrite(ids.map((id, i) => ({
    updateOne: { filter: { _id: id }, update: { $set: { orgChartOrder: { branch, index: i } } } },
  })));
  res.json({ branch, order: ids });
});

module.exports = { orgChart, setChartOrder };
