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
 * @route GET /api/org/chart
 * @param {string} [req.query.company] - Company id to narrow the chart to.
 * @returns {{roots: Object[], companies: Object[]}} each node
 *   {id, profileId, name, designation, department, companyId, companyName, role, managerId, reports[]}
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
    .select('user reportingManager designation department company')
    .populate('user', 'firstName lastName email photo role')
    .populate('company', 'name')
    .lean();

  // Build one node per employee, keyed by the user id.
  const nodes = new Map();
  for (const p of profiles) {
    if (!p.user) continue; // skip orphaned profiles with no linked user
    const id = p.user._id.toString();
    const name = `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim();
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
    .select('firstName lastName photo role companies')
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
      reports: [],
    });
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

module.exports = { orgChart };
