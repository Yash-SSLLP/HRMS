import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Link, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import api from '../api/client';
import ChatDock from './ChatDock';
import PageSkeleton from './PageSkeleton';
import AuthImage from './AuthImage';
import { FiPlus, FiMinus, FiSun, FiMoon, FiBell, FiCalendar, FiClock } from 'react-icons/fi';
import { COMPANY_NAME, COMPANY_LOGO } from '../config/company';
import { hasPermission, hasAnyPermission } from '../config/permissions';

const ROLE_LABELS = { SuperAdmin: 'Super Admin', HRManager: 'HR Manager', CEO: 'CEO', MD: 'MD', Manager: 'Manager', LDManager: 'HR L&D', Employee: 'Employee' };

const NOTIF_POLL_MS = 20000;

function initials(user) {
  const a = (user?.firstName || '').trim()[0] || '';
  const b = (user?.lastName || '').trim()[0] || '';
  return (a + b).toUpperCase() || 'U';
}

// User avatar: profile photo when set, otherwise initials on the accent colour.
// The photo path (which changes on every upload) is used as a cache-buster so
// the image refreshes immediately after a change.
function UserAvatar({ user }) {
  const fallback = <span className="avatar-circle accent-bg text-white">{initials(user)}</span>;
  if (!user?.photo) return fallback;
  return (
    <AuthImage
      url={`/auth/users/${user._id}/avatar?p=${encodeURIComponent(user.photo)}`}
      alt={initials(user)}
      className="avatar-circle object-cover"
      fallback={fallback}
    />
  );
}

// A single sidebar link. `item.icon` is a react-icon component.
function NavLeaf({ item, onNavigate }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `nav-link ${item.danger ? 'nav-link-danger' : ''} ${item.highlight ? 'nav-link-highlight' : ''} ${isActive ? 'nav-link-active' : ''}`}
    >
      <span className="nav-icon" aria-hidden="true">{Icon ? <Icon size={15} /> : null}</span>
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

// Sidebar navigation. Accepts either a flat list of items (employee portal) or a
// list of { group, items } category groups (admin portal), rendered as smooth
// collapsible dropdowns. The group containing the current route auto-opens.
function NavList({ items, user, onNavigate }) {
  const { pathname } = useLocation();
  const grouped = items.length > 0 && !!items[0].group;
  const visible = (arr) => arr.filter((i) => {
    if (i.roles && !i.roles.includes(user?.role)) return false;
    if (i.perm && !hasPermission(user, i.perm)) return false;
    if (i.anyPerm && !hasAnyPermission(user, i.anyPerm)) return false;
    return true;
  });
  const groupActive = (g) => (g.items || []).some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));

  // Multiple groups can be open at once. The active group auto-opens (without
  // closing others).
  const [open, setOpen] = useState(() => {
    const init = {};
    if (grouped) items.forEach((g) => { init[g.group] = groupActive(g); });
    return init;
  });

  useEffect(() => {
    if (!grouped) return;
    setOpen((prev) => {
      const next = { ...prev };
      items.forEach((g) => { if (groupActive(g)) next[g.group] = true; });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  if (!grouped) {
    return visible(items).map((item) => <NavLeaf key={item.to} item={item} onNavigate={onNavigate} />);
  }

  return items.map((g) => {
    const children = visible(g.items);
    if (!children.length) return null;

    // A category with a single (visible) item isn't worth a dropdown — render
    // it as a plain section link straight to that item.
    if (children.length === 1) {
      const only = children[0];
      return (
        <NavLink
          key={g.group}
          to={only.to}
          end={only.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `nav-section-link ${only.danger ? 'nav-link-danger' : ''} ${isActive ? 'is-active' : ''}`}
        >
          {g.group}
        </NavLink>
      );
    }

    const isOpen = !!open[g.group];
    const hasHighlight = children.some((i) => i.highlight);
    return (
      <div key={g.group} className={`nav-group ${isOpen ? 'is-open' : ''}`}>
        <button
          type="button"
          onClick={() => setOpen((o) => ({ ...o, [g.group]: !o[g.group] }))}
          className={`nav-group-header ${isOpen ? 'is-open' : ''} ${hasHighlight ? 'nav-group-header-highlight' : ''}`}
          aria-expanded={isOpen}
        >
          <span className="truncate flex-1 text-left min-w-0">{g.group}</span>
          <span className="nav-group-toggle">
            {isOpen
              ? <FiMinus className="nav-group-pm" aria-hidden="true" />
              : <FiPlus className="nav-group-pm" aria-hidden="true" />}
          </span>
        </button>
        <div className={`nav-group-body ${isOpen ? 'is-open' : ''}`}>
          <div className="nav-group-inner space-y-0.5">
            {children.map((item) => <NavLeaf key={item.to} item={item} onNavigate={onNavigate} />)}
          </div>
        </div>
      </div>
    );
  });
}

function NotificationBell({ isAdmin, portal }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();
  const wrapRef = useRef(null);

  // Only show notifications for the portal being viewed, so a dual-role user
  // (e.g. an HRManager who is also an employee) doesn't see their admin
  // notifications in My Portal or vice versa.
  const load = async () => {
    try {
      const { data } = await api.get('/notifications', { params: { audience: portal } });
      setItems(data.notifications);
      setUnread(data.unreadCount);
    } catch {
      // Silent — the bell shouldn't break the page on a transient error.
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, NOTIF_POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portal]);

  // Close dropdown on outside click.
  useEffect(() => {
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const resolveLink = (n) => {
    if (!n.link) return null;
    if (n.link === 'calendar') return isAdmin ? '/admin/calendar' : '/employee/calendar';
    // Legacy course links were stored as "/learning"; the actual route lives
    // under the employee portal. Normalise so older notifications still land.
    if (n.link === '/learning' || n.link.startsWith('/learning/')) return `/employee${n.link}`;
    return n.link;
  };

  const openNotif = async (n) => {
    setOpen(false);
    try {
      if (!n.readAt) {
        await api.patch(`/notifications/${n._id}/read`);
        setUnread((u) => Math.max(0, u - 1));
        setItems((prev) => prev.map((x) => (x._id === n._id ? { ...x, readAt: new Date().toISOString() } : x)));
      }
    } catch {
      // ignore
    }
    const target = resolveLink(n);
    if (target) navigate(target);
  };

  const markAll = async () => {
    try {
      await api.patch('/notifications/read-all', null, { params: { audience: portal } });
      setUnread(0);
      setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt || new Date().toISOString() })));
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="topbar-icon-btn"
        aria-label="Notifications"
      >
        <FiBell size={19} strokeWidth={2} />
        {unread > 0 && (
          <span className="bell-badge absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 bg-red-500 text-white text-[10px] font-semibold rounded-full flex items-center justify-center shadow-sm">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-800">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-blue-600 hover:underline">Mark all read</button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-gray-500">No notifications</div>
            ) : items.map((n) => (
              <button
                key={n._id}
                onClick={() => openNotif(n)}
                className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-gray-50 ${
                  n.readAt ? '' : 'bg-blue-50'
                }`}
              >
                <div className="text-sm text-gray-900 break-words">{n.title}</div>
                {n.body && <div className="text-xs text-gray-600 mt-0.5 break-words line-clamp-3">{n.body}</div>}
                <div className="text-[10px] text-gray-400 mt-1">{new Date(n.createdAt).toLocaleString([], { hour12: true })}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Admin global employee search — debounced lookup against /employees?q= with a
// results dropdown that navigates to the employee's detail page.
// Global search in the top bar. Everyone can jump to any page/section they have
// access to (type "attendance" → go straight there). HR/Admins additionally get
// live employee results (name / code / email) that open the employee record.
function GlobalSearch({ navItems = [], user, isAdmin }) {
  const [q, setQ] = useState('');
  const [employees, setEmployees] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);
  const navigate = useNavigate();

  // Flatten the current portal's nav into the pages this user is allowed to see.
  const pages = useMemo(() => {
    const canSee = (i) => {
      if (i.roles && !i.roles.includes(user?.role)) return false;
      if (i.perm && !hasPermission(user, i.perm)) return false;
      if (i.anyPerm && !hasAnyPermission(user, i.anyPerm)) return false;
      return true;
    };
    const out = [];
    (navItems || []).forEach((g) => {
      const items = g.items || (g.to ? [g] : []);
      items.forEach((i) => {
        if (i.to && canSee(i)) out.push({ to: i.to, label: i.label, icon: i.icon, group: g.group || '' });
      });
    });
    return out;
  }, [navItems, user]);

  const term = q.trim().toLowerCase();
  const pageMatches = term
    ? pages.filter((p) => p.label.toLowerCase().includes(term) || p.group.toLowerCase().includes(term)).slice(0, 6)
    : [];

  // Employee lookup (HR/Admin only), debounced.
  useEffect(() => {
    if (!isAdmin || !term) { setEmployees([]); setLoading(false); return undefined; }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/employees', { params: { q: q.trim() } });
        setEmployees((data.profiles || []).slice(0, 6));
      } catch {
        setEmployees([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, isAdmin]);

  useEffect(() => {
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const reset = () => { setOpen(false); setQ(''); setEmployees([]); };
  const goPage = (to) => { reset(); navigate(to); };
  const goEmp = (p) => { reset(); navigate(`/admin/employees/${p._id}`); };

  const init = (p) =>
    ((p.user?.firstName?.[0] || '') + (p.user?.lastName?.[0] || '')).toUpperCase() || 'E';

  const nothing = term && !loading && pageMatches.length === 0 && employees.length === 0;

  return (
    <div className="hidden md:flex items-center flex-1 max-w-md relative" ref={wrapRef}>
      <div className="relative w-full">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
        <input
          type="text"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={isAdmin ? 'Search pages or employees…' : 'Search pages…'}
          className="w-full pl-9 pr-3 py-2 text-sm bg-gray-100 border border-transparent rounded-lg focus:bg-white focus:border-gray-300 focus:outline-none"
        />
      </div>
      {open && term && (
        <div className="absolute top-full left-0 mt-1 w-full bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden max-h-[70vh] overflow-y-auto">
          {/* Pages / sections */}
          {pageMatches.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Pages</div>
              {pageMatches.map((p) => {
                const Icon = p.icon;
                return (
                  <button
                    key={p.to}
                    onClick={() => goPage(p.to)}
                    className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 border-b border-gray-50 last:border-0"
                  >
                    <span className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center text-gray-500 shrink-0">
                      {Icon ? <Icon size={15} /> : '›'}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 truncate">{p.label}</span>
                      {p.group ? <span className="block text-xs text-gray-400 truncate">{p.group}</span> : null}
                    </span>
                  </button>
                );
              })}
            </>
          )}

          {/* Employees (HR/Admin only) */}
          {isAdmin && (
            <>
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Employees</div>
              {loading ? (
                <div className="px-4 py-3 text-sm text-gray-500">Searching…</div>
              ) : employees.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-500">No employees found</div>
              ) : (
                employees.map((p) => (
                  <button
                    key={p._id}
                    onClick={() => goEmp(p)}
                    className="w-full text-left px-3 py-2 flex items-center gap-3 hover:bg-gray-50 border-b border-gray-50 last:border-0"
                  >
                    <span className="avatar-circle accent-bg text-white">{init(p)}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-900 truncate">
                        {`${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode}
                      </span>
                      <span className="block text-xs text-gray-500 truncate">
                        {p.employeeCode} · {p.designation || '-'} · {p.department || '-'}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </>
          )}

          {nothing && !isAdmin && (
            <div className="px-4 py-3 text-sm text-gray-500">No pages found</div>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ user, employeeCode, onLogout }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // SuperAdmin has no employee profile/portal, so send them to their account
  // page; everyone else goes to their profile (where they can raise change-
  // request tickets for their own details).
  const profilePath = user?.role === 'SuperAdmin' ? '/admin/account' : '/employee/profile';

  useEffect(() => {
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  return (
    <div className="relative" ref={wrapRef}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-gray-100">
        <UserAvatar user={user} />
        <span className="hidden sm:flex flex-col items-start leading-tight">
          <span className="text-sm font-medium text-gray-800">{user?.firstName} {user?.lastName}</span>
          <span className="text-[11px] text-gray-500">
            {employeeCode ? `${employeeCode} · ${ROLE_LABELS[user?.role] || user?.role}` : (ROLE_LABELS[user?.role] || user?.role)}
          </span>
        </span>
        <span className="text-gray-400 text-xs hidden sm:inline">▾</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
            <UserAvatar user={user} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-900 truncate">{user?.firstName} {user?.lastName}</div>
              {employeeCode && <div className="text-xs text-gray-500 truncate">{employeeCode}</div>}
              <div className="text-xs text-gray-500 truncate">{user?.email}</div>
            </div>
          </div>
          <Link to={profilePath} onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50">My Profile</Link>
          <button onClick={() => { setOpen(false); onLogout(); }}
            className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50">Log out</button>
        </div>
      )}
    </div>
  );
}

export default function Layout({ navItems = [], sectionTitle }) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const setUser = useAuthStore((s) => s.setUser);
  const mode = useThemeStore((s) => s.mode);
  const toggleMode = useThemeStore((s) => s.toggle);
  const navigate = useNavigate();

  // Re-sync the cached user from the server on load so the top-bar profile
  // reflects any changes made since login (e.g. an approved name-change ticket
  // or an admin edit), instead of showing the stale name until re-login.
  useEffect(() => {
    api.get('/auth/me').then(({ data }) => data?.user && setUser(data.user)).catch(() => {});
  }, [setUser]);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // The auth `user` is a User doc (no designation — that lives on the employee
  // profile). Fetch it so the sidebar card can show the person's job title.
  const [designation, setDesignation] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  useEffect(() => {
    api.get('/employees/me')
      .then(({ data }) => {
        setDesignation(data?.profile?.designation || '');
        setEmployeeCode(data?.profile?.employeeCode || '');
      })
      .catch(() => { setDesignation(''); setEmployeeCode(''); });
  }, [user?._id]);

  const handleLogout = () => {
    setConfirmLogout(false);
    logout();
    navigate('/login', { replace: true });
  };

  const isAdmin = user && (user.role === 'SuperAdmin' || user.role === 'HRManager');
  // CEO/MD: read-only executives who can browse the whole admin portal.
  const isExecViewer = user && (user.role === 'CEO' || user.role === 'MD');
  // SuperAdmin is not an employee, so they have no "My Portal". Only roles with
  // employee-portal access (Employee, HRManager) get the portal switcher.
  const canEmployeePortal = user && user.role !== 'SuperAdmin';

  // Which portal is being viewed drives the colour theme (Admin vs My Portal),
  // so the same admin user gets a visibly different look in each. Applied to
  // <html> as data-portal; index.css maps it to the accent + surface palette.
  const portal = sectionTitle === 'Admin' ? 'admin' : 'employee';
  // Quick top-bar shortcut targets — the current portal's Calendar & Attendance.
  const calendarPath = portal === 'admin' ? '/admin/calendar' : '/employee/calendar';
  const attendancePath = portal === 'admin' ? '/admin/attendance' : '/employee/attendance';
  useEffect(() => {
    document.documentElement.setAttribute('data-portal', portal);
  }, [portal]);

  // Close the mobile drawer whenever the route changes.
  const closeMobile = () => setMobileOpen(false);

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="h-16 flex items-center gap-2 px-5 border-b border-gray-100 shrink-0">
        <Link to={isAdmin ? '/admin' : '/employee'} onClick={closeMobile} className="flex items-center gap-2 min-w-0">
          <img src={COMPANY_LOGO} alt={COMPANY_NAME} className="h-8 w-auto" />
          <span className="text-base font-bold text-gray-900 truncate">{COMPANY_NAME}</span>
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 space-y-0.5">
        {sectionTitle && (
          <div className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold px-3 pb-2">
            {sectionTitle}
          </div>
        )}
        <NavList items={navItems} user={user} onNavigate={closeMobile} />
      </nav>
      <div className="border-t border-gray-100 p-3 shrink-0">
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg">
          <UserAvatar user={user} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-gray-800 truncate">{user?.firstName} {user?.lastName}</div>
            {employeeCode && <div className="text-[11px] text-gray-500 truncate">{employeeCode}</div>}
            <div className="text-[11px] text-gray-400 truncate">{designation || ROLE_LABELS[user?.role] || user?.role}</div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-full" style={{ backgroundColor: 'var(--bg)' }}>
      <div className="h-1 accent-bg fixed top-0 inset-x-0 z-50" />

      {/* Desktop fixed sidebar */}
      <aside className="hidden lg:flex fixed top-1 left-0 bottom-0 w-80 bg-white border-r border-gray-200 z-40">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40 lg:hidden" onClick={closeMobile} />
          <aside className="fixed top-0 left-0 bottom-0 w-80 max-w-[85vw] bg-white border-r border-gray-200 z-50 lg:hidden">
            {sidebar}
          </aside>
        </>
      )}

      {/* Content column */}
      <div className="lg:pl-80 flex flex-col min-h-screen">
        <header className="sticky top-1 z-30 h-16 bg-white border-b border-gray-200 flex items-center gap-3 px-4 sm:px-6">
          <button onClick={() => setMobileOpen(true)} className="topbar-icon-btn lg:hidden" aria-label="Open menu">
            <span className="text-xl leading-none">☰</span>
          </button>

          {/* Quick shortcuts — available to everyone, in both portals. Icon shows
              on all sizes; the label appears from sm up so each is unmistakable. */}
          <Link to={calendarPath} title="Calendar" aria-label="Calendar"
            className="inline-flex items-center gap-1.5 shrink-0 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900">
            <FiCalendar size={16} strokeWidth={2} />
            <span className="hidden sm:inline">Calendar</span>
          </Link>
          <Link to={attendancePath} title="Attendance" aria-label="Attendance"
            className="inline-flex items-center gap-1.5 shrink-0 px-2 sm:px-3 py-1.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900">
            <FiClock size={16} strokeWidth={2} />
            <span className="hidden sm:inline">Attendance</span>
          </Link>

          <GlobalSearch navItems={navItems} user={user} isAdmin={isAdmin} />

          {isExecViewer && (
            <span className="hidden sm:inline-flex items-center gap-1 ml-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200"
              title="CEO/MD accounts can view everything but cannot make changes">
              👁 View only
            </span>
          )}

          <div className="flex items-center gap-1 sm:gap-2 ml-auto">
            {isAdmin && canEmployeePortal && (
              <div className="hidden sm:flex items-center gap-1 bg-gray-100 rounded-full p-0.5 mr-1">
                <Link
                  to="/admin"
                  className={`text-sm px-3 py-1 rounded-full transition-colors ${
                    portal === 'admin' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  Admin
                </Link>
                <Link
                  to="/employee"
                  className={`text-sm px-3 py-1 rounded-full transition-colors ${
                    portal === 'employee' ? 'accent-bg text-white font-medium shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  My Portal
                </Link>
              </div>
            )}
            <button
              onClick={toggleMode}
              title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="topbar-icon-btn"
            >
              {mode === 'dark' ? <FiSun size={19} strokeWidth={2} /> : <FiMoon size={18} strokeWidth={2} />}
            </button>
            <NotificationBell isAdmin={isAdmin} portal={portal} />
            <span className="hidden sm:block w-px h-6 bg-gray-200 mx-1" />
            <ProfileMenu user={user} employeeCode={employeeCode} onLogout={() => setConfirmLogout(true)} />
          </div>
        </header>

        {/* pb-24 keeps page content (e.g. bottom action buttons) clear of the
            fixed ChatDock bar in the bottom-right corner. */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 pb-24">
          <Suspense fallback={<PageSkeleton />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {confirmLogout && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-[60]"
          onClick={() => setConfirmLogout(false)}>
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900">Log out?</h2>
            <p className="text-sm text-gray-500 mt-1 mb-5">
              You’ll be signed out of {COMPANY_NAME} and returned to the login screen.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmLogout(false)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
                autoFocus
              >
                Cancel
              </button>
              <button
                onClick={handleLogout}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Log out
              </button>
            </div>
          </div>
        </div>
      )}

      <ChatDock />
    </div>
  );
}
