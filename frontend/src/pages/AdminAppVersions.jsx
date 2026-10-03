/**
 * AdminAppVersions — which app build each person is running (Backend only).
 *
 * THREE ANSWERS, and the difference between them is the whole point of the page:
 *
 *   a version   the phone registered for push and reported its native build.
 *   Web only    no device registration at all. That USUALLY means they have
 *               never installed the app — but it also covers two cases that look
 *               identical from here: someone who opened the app and declined
 *               notification permission (registerForPush returns before posting),
 *               and someone who signed OUT of the app, since logout deletes the
 *               row (unregisterPush → DELETE /devices/:token). So read it as "no
 *               app registered right now", not as "has never had the app".
 *   Unknown     a device IS registered but reported no version, meaning it last
 *               checked in from a build older than the one that started sending
 *               it. An app that never told us cannot be asked retrospectively.
 *
 * "Unknown" is deliberately not folded into "out of date". It will describe
 * EVERY phone until people update to the first build that reports its version,
 * and calling that "old" would be a guess dressed as a fact.
 *
 * The version refreshes every time the app is opened (registerForPush runs on
 * launch), so a row only goes stale once the phone stops opening the app — which
 * is what "last opened" tells you.
 *
 * Backend: GET /admin/app-versions.
 */
import { useEffect, useState } from 'react';
import {
  FiSmartphone, FiGlobe, FiHelpCircle, FiCheckCircle, FiAlertTriangle, FiSearch, FiUsers,
} from 'react-icons/fi';
import '../styles/pages/org-help.css';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { PersonAvatar, RoleChip } from '../components/permissions/permUi';

// What "Web only" and "Unknown" mean, carried as tooltips (KPI, filter, chip)
// rather than as paragraphs on the page.
const WEB_TIP = 'No app registered right now: never installed, signed out of the app, or notifications declined — these look the same from the server.';
const UNKNOWN_TIP = 'The app on this phone last checked in from a build that did not report its version. It means not known — not old.';

/** PersonAvatar wants first/last names; this list carries one `name`. No photo here, so initials. */
const avatarUser = (r) => {
  const parts = (r.name || '').trim().split(/\s+/).filter(Boolean);
  return { _id: r._id, firstName: parts[0] || '', lastName: parts.length > 1 ? parts[parts.length - 1] : '' };
};

/** "today" / "3 days ago" / "never" — coarse on purpose. */
function ago(iso) {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** How fresh "last opened" is, for the dot beside it. */
function seenTone(iso) {
  if (!iso) return 'is-old';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 2) return 'is-fresh';
  if (days < 30) return '';
  return 'is-old';
}

/** The version cell — the one place the three states are told apart. */
function VersionCell({ r, latest }) {
  if (r.state === 'web') {
    return (
      <span className="av-ver is-web" title={WEB_TIP}>
        <FiGlobe size={12} aria-hidden="true" /> Web only
      </span>
    );
  }
  if (r.state === 'unknown') {
    return (
      <span className="av-ver is-unknown" title={UNKNOWN_TIP}>
        <FiHelpCircle size={12} aria-hidden="true" /> Unknown
      </span>
    );
  }
  const behind = latest && r.appVersionCode != null && r.appVersionCode < latest.versionCode;
  const current = !behind && r.upToDate === true;
  // Wraps on a phone, where the cell is capped at 11rem: a nowrap row there
  // crushed "(code)" and "out of date" into slivers a letter wide.
  return (
    <span className="av-ver-wrap">
      <span className={`av-ver${behind ? ' is-behind' : current ? ' is-ok' : ''}`}>
        {behind ? <FiAlertTriangle size={12} aria-hidden="true" />
          : current ? <FiCheckCircle size={12} aria-hidden="true" />
            : <FiSmartphone size={12} aria-hidden="true" />}
        {r.appVersion}
        {r.appVersionCode != null && <span className="av-ver-code">({r.appVersionCode})</span>}
      </span>
      {behind && <span className="av-ver-note">Out of date</span>}
    </span>
  );
}

const FILTERS = [
  { id: 'all', label: 'Everyone' },
  { id: 'behind', label: 'Out of date' },
  { id: 'web', label: 'Web only' },
  { id: 'unknown', label: 'Unknown' },
];

export default function AdminAppVersions() {
  // SuperAdmin-only, matching the backend gate. Checked on the ROLE, not a
  // capability: the client's hasPermission answers true for CEO/MD on everything,
  // and this is a device inventory of the whole company.
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [rows, setRows] = useState([]);
  const [latest, setLatest] = useState(null);
  const [summary, setSummary] = useState({});
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isSuperAdmin) return;
    api.get('/admin/app-versions')
      .then(({ data }) => {
        setRows(data.accounts || []);
        setLatest(data.latest || null);
        setSummary(data.summary || {});
      })
      .catch((err) => setError(err.response?.data?.message || 'Failed to load app versions'))
      .finally(() => setLoading(false));
  }, [isSuperAdmin]);

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="App Versions" />
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">
          This tool isn&apos;t available for your account.
        </div>
      </div>
    );
  }

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (tab === 'behind' && r.upToDate !== false) return false;
    if (tab === 'web' && r.state !== 'web') return false;
    if (tab === 'unknown' && r.state !== 'unknown') return false;
    if (!needle) return true;
    return `${r.name} ${r.email} ${r.employeeCode} ${r.appVersion || ''} ${r.deviceName}`.toLowerCase().includes(needle);
  });

  // Per-filter counts for the segmented control — the same tests the filter
  // above applies, over everything loaded.
  const counts = {
    all: rows.length,
    behind: rows.filter((r) => r.upToDate === false).length,
    web: rows.filter((r) => r.state === 'web').length,
    unknown: rows.filter((r) => r.state === 'unknown').length,
  };
  const dash = (v) => (loading ? '—' : v ?? '-');
  // The KPI cards double as the filter: the three that name a state switch to
  // it. "On the latest build" has no filter of its own, so it is a plain card.
  const KPIS = [
    { key: 'latest', filter: null, icon: FiCheckCircle, hue: '#16a34a', value: dash(summary.onLatest), label: 'On the latest build',
      sub: !loading && summary.total != null ? `of ${summary.total} people` : null },
    { key: 'behind', filter: 'behind', icon: FiAlertTriangle, hue: '#d97706', value: dash(summary.behind), label: 'Out of date' },
    { key: 'web', filter: 'web', icon: FiGlobe, hue: '#0ea5e9', value: dash(summary.webOnly), label: 'No app registered', tip: WEB_TIP },
    { key: 'unknown', filter: 'unknown', icon: FiHelpCircle, hue: '#64748b', value: dash(summary.unknown), label: 'Version not reported', tip: UNKNOWN_TIP },
  ];

  return (
    <div>
      <PageHeader
        title="App Versions"
        subtitle={latest
          ? `Latest published build: ${latest.versionName} (${latest.versionCode})`
          : undefined}
      />

      <div className="trn-kpis">
        {KPIS.map((k) => {
          const Icon = k.icon;
          const on = k.filter && tab === k.filter;
          const body = (
            <>
              <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
              <span className="min-w-0">
                <span className="trn-kpi-value block tabular-nums">{k.value}</span>
                <span className="trn-kpi-label block">{k.label}</span>
                {k.sub && <span className="trn-kpi-sub block">{k.sub}</span>}
              </span>
            </>
          );
          return k.filter ? (
            <button key={k.key} type="button" onClick={() => setTab(k.filter)} aria-pressed={on}
              title={k.tip} className={`trn-kpi pb-kpi${on ? ' is-on' : ''}`} style={{ '--kpi-hue': k.hue }}>
              {body}
            </button>
          ) : (
            <div key={k.key} className="trn-kpi pb-kpi" style={{ '--kpi-hue': k.hue }}>{body}</div>
          );
        })}
      </div>

      {/* One bar: the state filter, then search. */}
      <div className="pb-toolbar av-toolbar">
        <div className="trn-seg" role="tablist" aria-label="Filter by state">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" onClick={() => setTab(f.id)}
              aria-selected={tab === f.id}
              title={f.id === 'web' ? WEB_TIP : f.id === 'unknown' ? UNKNOWN_TIP : undefined}
              className={`trn-seg-btn${tab === f.id ? ' is-on' : ''}`}>
              {f.label}
              {!loading && <span className="trn-seg-count">{counts[f.id]}</span>}
            </button>
          ))}
        </div>
        <div className="pb-toolbar-end">
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" aria-hidden="true" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, email, code, version or device…"
              aria-label="Search accounts"
            />
          </label>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">{error}</div>
      )}

      {loading ? (
        <div className="grid gap-2" aria-busy="true" aria-label="Loading app versions">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-14 rounded-2xl" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiUsers size={24} /></span>
            <p className="text-sm font-semibold">Nobody matches that.</p>
          </div>
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm av-table">
              <thead>
                <tr className="text-left text-gray-600">
                  <th className="px-4 py-3 font-semibold">Employee</th>
                  <th className="px-4 py-3 font-semibold">Code</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">App version</th>
                  <th className="px-4 py-3 font-semibold">Phone</th>
                  <th className="px-4 py-3 font-semibold">App last opened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((r) => (
                  <tr key={r._id}>
                    <td className="px-4 py-3">
                      <div className="av-who">
                        <PersonAvatar user={avatarUser(r)} />
                        <div className="min-w-0">
                          <div className="av-name">{r.name || '-'}</div>
                          <div className="av-mail">{r.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {r.employeeCode ? <span className="av-code">{r.employeeCode}</span> : <span className="av-none">—</span>}
                    </td>
                    <td className="px-4 py-3"><RoleChip role={r.role} /></td>
                    <td className="px-4 py-3"><VersionCell r={r} latest={latest} /></td>
                    <td className="px-4 py-3">
                      {r.deviceName ? (
                        <span className="av-dev">
                          <FiSmartphone size={13} aria-hidden="true" className="shrink-0 opacity-50" />
                          <span className="min-w-0">{r.deviceName}</span>
                        </span>
                      ) : <span className="av-none">—</span>}
                      {r.deviceCount > 1 && (
                        <span className="av-more">+{r.deviceCount - 1} more</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.state === 'web' ? <span className="av-none">—</span> : (
                        <span className={`av-seen ${seenTone(r.deviceSeenAt)}`}>{ago(r.deviceSeenAt)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
