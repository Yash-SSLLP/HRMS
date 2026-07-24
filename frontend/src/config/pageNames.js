// Maps an in-app route path to a human-readable page name, used to report page
// views to the server console (see Layout's navigation logger). Built once from
// the sidebar nav configs so the reported name matches the sidebar label.
import { adminNav, employeeNav } from './nav';

// Flatten the grouped/flat nav configs into a { path: label } lookup.
function buildMap(...navs) {
  const map = {};
  for (const nav of navs) {
    for (const node of nav) {
      if (node.items) {
        for (const item of node.items) map[item.to] = item.label;
      } else if (node.to) {
        map[node.to] = node.label;
      }
    }
  }
  return map;
}

const NAV_LABELS = buildMap(adminNav, employeeNav);

// Names for portal landing routes and pages that aren't sidebar items
// (detail/player pages, dynamic segments), keyed by path or path prefix.
const EXTRA = {
  '/admin': 'Admin Home',
  '/employee': 'Overview',
  '/admin/approvals': 'Approvals',
  '/admin/leave-approvals': 'Approvals',
  '/admin/payroll-run': 'Monthly Payroll Run',
};

// Turn a path segment like "review-cycles" into "Review Cycles" as a last resort.
function prettify(segment) {
  return segment
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function pageNameForPath(pathname) {
  if (!pathname) return 'Unknown Page';
  const clean = pathname.replace(/\/+$/, '') || '/';

  if (NAV_LABELS[clean]) return NAV_LABELS[clean];
  if (EXTRA[clean]) return EXTRA[clean];

  // Dynamic routes (e.g. /admin/employees/123, /employee/learning/abc): match on
  // the parent path, else fall back to a prettified last segment.
  const parts = clean.split('/').filter(Boolean);
  const parent = `/${parts.slice(0, -1).join('/')}`;
  if (NAV_LABELS[parent]) return `${NAV_LABELS[parent]} — Detail`;

  const last = parts[parts.length - 1];
  return last ? prettify(last) : 'Home';
}
