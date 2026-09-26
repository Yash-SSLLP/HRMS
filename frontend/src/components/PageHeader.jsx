// Standardised page header: an icon tile, an eyebrow, the title, an optional
// subtitle, and an optional actions slot on the right (buttons, filters, etc.).
//
// IT WEARS THE SIDEBAR'S OWN LANGUAGE (2026-09-26, user ask: "design every page
// to match the [sidebar] design"). The icon is the one the page's sidebar row
// carries, and the eyebrow is that row's CATEGORY in the sidebar's uppercase
// tracked label — so "LEAVE & HOLIDAYS / Leave" reads as the same place you just
// clicked. Both are looked up from config/nav by the current path, so none of
// the ~100 pages that render this had to change; `icon` / `eyebrow` props
// override the lookup where a page wants something else, and `eyebrow={null}`
// drops it.
//
// THE ACTIONS STAY ON THE RIGHT. The title block used to be sized by its text,
// so on a 13" laptop — where the fixed sidebar leaves ~1000px of page — a long
// subtitle made that block the full width and the buttons dropped to a line of
// their own at the LEFT. Now the title block takes whatever the actions leave
// (`grow`, wrapping its own text) and only gives way below 18rem, and the
// actions carry `ml-auto`, so even when there is truly no room for both on one
// line — a phone — they wrap to the right, not to the left.
import { useLocation } from 'react-router-dom';
import { adminNav, employeeNav, ldNav, accountsNav, consultancyNav } from '../config/nav';
import { useAuthStore } from '../store/authStore';

// Every navigable row, flattened, with the category it sits in. A pinned row
// (Dashboard, Approvals) has no category.
function flatten(nav) {
  const out = [];
  for (const entry of nav) {
    if (entry.group) {
      for (const item of entry.items || []) out.push({ to: item.to, end: item.end, icon: item.icon || entry.icon, group: entry.group });
    } else if (entry.to) {
      out.push({ to: entry.to, end: entry.end, icon: entry.icon, group: null });
    }
  }
  return out;
}
// Built once. The admin list comes first so a page that also appears in a
// single-purpose nav (ldNav's Courses) keeps its real category.
const ADMIN_ROWS = flatten([...adminNav, ...ldNav, ...accountsNav, ...consultancyNav]);
const EMPLOYEE_ROWS = flatten(employeeNav);

// The sidebar row this path belongs to: the LONGEST `to` that is the path or a
// parent of it, so /admin/employees/123 finds "Employees". An `end` row (the
// My Portal dashboard at /employee) only ever matches itself.
function rowFor(pathname, rows) {
  let best = null;
  for (const row of rows) {
    const hit = pathname === row.to || (!row.end && pathname.startsWith(`${row.to}/`));
    if (hit && (!best || row.to.length > best.to.length)) best = row;
  }
  return best;
}

export default function PageHeader({ title, subtitle, children, icon, eyebrow }) {
  const { pathname } = useLocation();
  const role = useAuthStore((s) => s.user?.role);
  const portal = pathname.startsWith('/employee') ? 'employee' : pathname.startsWith('/admin') ? 'admin' : null;
  const row = portal ? rowFor(pathname, portal === 'employee' ? EMPLOYEE_ROWS : ADMIN_ROWS) : null;
  const portalLabel = portal === 'employee' ? 'My Portal' : role === 'HRConsultancy' ? 'Consultancy' : portal ? 'Admin' : null;

  // The category, unless it would only repeat the title ("LEAVE / Leave" in
  // My Portal, where Leave is a one-page category) — then the portal's name.
  let label = eyebrow;
  if (label === undefined) {
    label = row?.group || portalLabel;
    if (label && typeof title === 'string' && label.toLowerCase() === title.trim().toLowerCase()) label = portalLabel;
  }
  const Icon = icon === undefined ? row?.icon : icon;

  return (
    <div className="page-head flex flex-wrap items-center justify-between gap-3 mb-5">
      <div className="min-w-0 grow basis-72 flex items-center gap-3.5">
        {Icon && (
          <span className="page-head-icon" aria-hidden="true"><Icon size={20} /></span>
        )}
        <div className="min-w-0">
          {label && <div className="page-eyebrow">{label}</div>}
          <h1 className="page-title text-2xl font-semibold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{children}</div>}
    </div>
  );
}
