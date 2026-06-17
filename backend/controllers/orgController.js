const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');

// GET /api/org/chart
// Builds a read-only reporting hierarchy from EmployeeProfile records.
// Each node is keyed by the profile's USER id and links to its manager via
// the profile's `reportingManager` (also a User id). Employees with no
// manager, or whose manager is not an employee in the set, surface as roots.
const orgChart = asyncHandler(async (req, res) => {
  const profiles = await EmployeeProfile.find({})
    .select('user reportingManager designation department')
    .populate('user', 'firstName lastName email')
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
      managerId: p.reportingManager ? p.reportingManager.toString() : null,
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

  res.json({ roots: safeRoots });
});

module.exports = { orgChart };
