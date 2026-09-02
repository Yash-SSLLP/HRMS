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
import { FiSmartphone, FiGlobe, FiHelpCircle, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { roleLabel } from '../config/roles';

const ROLE_CHIP = {
  SuperAdmin: 'bg-violet-50 text-violet-700 border-violet-200',
  HRManager: 'bg-teal-50 text-teal-700 border-teal-200',
  CEO: 'bg-amber-50 text-amber-800 border-amber-200',
  MD: 'bg-amber-50 text-amber-800 border-amber-200',
  Manager: 'bg-blue-50 text-blue-700 border-blue-200',
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

function Tile({ icon, tint, value, label }) {
  return (
    <div className="bg-white shadow rounded-lg p-4 flex items-center gap-3">
      <span className={`stat-icon ${tint}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-xl font-semibold text-gray-900 tabular-nums">{value}</div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </div>
  );
}

/** The version cell — the one place the three states are told apart. */
function VersionCell({ r, latest }) {
  if (r.state === 'web') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm text-gray-500"
        title="No app registered: never installed, signed out of the app, or notifications declined — these look the same from the server."
      >
        <FiGlobe size={13} /> Web only
      </span>
    );
  }
  if (r.state === 'unknown') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-sm text-gray-400"
        title="The app on this phone last checked in from a build that did not report its version."
      >
        <FiHelpCircle size={13} /> Unknown
      </span>
    );
  }
  const behind = latest && r.appVersionCode != null && r.appVersionCode < latest.versionCode;
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium tabular-nums ${behind ? 'text-amber-700' : 'text-gray-900'}`}>
      <FiSmartphone size={13} />
      {r.appVersion}
      {r.appVersionCode != null && <span className="text-gray-400 font-normal">({r.appVersionCode})</span>}
      {behind && <span className="text-[11px] font-semibold">· out of date</span>}
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
        <PageHeader title="App Versions" subtitle="Which app build each person is running" />
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

  return (
    <div>
      <PageHeader
        title="App Versions"
        subtitle={latest
          ? `Latest published build: ${latest.versionName} (${latest.versionCode})`
          : 'Which app build each person is running'}
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <Tile icon={<FiCheckCircle />} tint="bg-emerald-100 text-emerald-600" value={summary.onLatest ?? '-'} label="On the latest build" />
        <Tile icon={<FiAlertTriangle />} tint="bg-amber-100 text-amber-600" value={summary.behind ?? '-'} label="Out of date" />
        <Tile icon={<FiGlobe />} tint="bg-sky-100 text-sky-600" value={summary.webOnly ?? '-'} label="No app registered" />
        <Tile icon={<FiHelpCircle />} tint="bg-gray-100 text-gray-500" value={summary.unknown ?? '-'} label="Version not reported" />
      </div>

      {/* Said up front, because on the day this ships every phone reads "Unknown"
          and the page would otherwise look broken. */}
      {(summary.unknown ?? 0) > 0 && (
        <div className="bg-white shadow rounded-lg p-4 mb-4 text-sm text-gray-600">
          <p>
            <b>{summary.unknown}</b>{' '}
            {summary.unknown === 1 ? 'phone has' : 'phones have'} not reported a version.
            The app only started sending it recently, so a phone shows here until it is updated and
            opened once. It means <i>not known</i> — not <i>old</i>.
          </p>
        </div>
      )}

      {/* Said in the open, because acting on this column without knowing it is
          easy: chasing somebody to "install the app" when they signed out last
          night would be the obvious mistake. */}
      <p className="text-xs text-gray-500 mb-3">
        <b>Web only</b> means no app is registered to that account right now — they never installed it,
        they signed out of it, or they declined notifications. The three are indistinguishable from the server.
      </p>

      <div className="bg-white shadow rounded-lg p-5">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email, code, version or device…"
            className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[14rem]"
          />
          <nav className="seg-track" aria-label="Filter by state">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" onClick={() => setTab(f.id)}
                aria-pressed={tab === f.id}
                className={`seg-btn${tab === f.id ? ' is-active' : ''}`}>
                {f.label}
              </button>
            ))}
          </nav>
        </div>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">{error}</div>
        )}

        {loading ? (
          <p className="text-sm text-gray-400 italic py-6 text-center">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-sm text-gray-400 italic py-6 text-center">Nobody matches that.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
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
                      <div className="font-medium text-gray-900">{r.name || '-'}</div>
                      <div className="text-xs text-gray-500">{r.email}</div>
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {r.employeeCode ? <span className="font-mono text-xs">{r.employeeCode}</span> : <span className="text-xs text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-lg border ${ROLE_CHIP[r.role] || 'bg-gray-50 text-gray-700 border-gray-200'}`}>
                        {roleLabel(r.role)}
                      </span>
                    </td>
                    <td className="px-4 py-3"><VersionCell r={r} latest={latest} /></td>
                    <td className="px-4 py-3 text-gray-600">
                      {r.deviceName || <span className="text-xs text-gray-400">—</span>}
                      {r.deviceCount > 1 && (
                        <span className="ml-1 text-[11px] text-gray-400">+{r.deviceCount - 1} more</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {r.state === 'web' ? <span className="text-xs text-gray-400">—</span> : ago(r.deviceSeenAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
