/**
 * AdminPushNotifications — when the daily attendance push reminders fire.
 *
 * SuperAdmin-only: these push at the whole company, so the schedule sits above
 * the attendance.manage crowd who own the rest of PUT /attendance/settings. The
 * server enforces that too — it silently ignores the reminder block from anyone
 * else — so this page never offers a control the API would drop on the floor.
 *
 * The worker (backend/services/attendanceReminderWorker.js) re-reads these every
 * tick, so a change takes effect on the next pass; no deploy, no restart.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { confirmDialog } from '../components/dialogs';

// The two reminders, described in the terms an operator thinks in.
const REMINDERS = [
  {
    key: 'punchIn',
    label: 'Punch-in reminder',
    blurb: 'Sent to employees who have not checked in yet. Skipped on Sundays, listed holidays, '
      + 'and for anyone on approved leave — so nobody is nudged on a day off.',
    defaults: { hour: 9, minute: 45 },
  },
  {
    key: 'punchOut',
    label: 'Punch-out reminder',
    blurb: 'Sent to anyone who checked in but has not checked out. Worth keeping close to the end '
      + 'of the workday: a day left open is closed at an assumed 7:00 PM, which can turn a full '
      + 'day into a half day and cost the employee a regularization.',
    defaults: { hour: 19, minute: 0 },
  },
];

const pad2 = (n) => String(n).padStart(2, '0');
// "09:45" for an <input type="time">, which is 24-hour regardless of locale.
const toInput = (r) => `${pad2(r?.hour ?? 0)}:${pad2(r?.minute ?? 0)}`;
// The same instant read back as 12-hour, which is how the rest of the portal
// shows every time of day.
const to12 = (r) => {
  const h = Number(r?.hour ?? 0);
  return `${h % 12 || 12}:${pad2(r?.minute ?? 0)} ${h >= 12 ? 'PM' : 'AM'}`;
};

// ============ Custom reminders ============
// The two above are built in — their audiences are computed, so only the time is
// editable. These are open-ended: a SuperAdmin writes the message, picks a time,
// the weekdays it repeats on, and who receives it.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const blankCustom = () => ({
  title: '', body: '', hour: 10, minute: 0, days: [], audience: 'all', department: '', enabled: true,
});
const hhmm = (r) => `${pad2(r.hour)}:${pad2(r.minute)}`;
// "Every day" / "Mon–Fri" read better than a seven-chip row that is all on.
const daysLabel = (days) => {
  if (!days?.length) return 'Every day';
  const set = [...days].sort();
  if (set.join() === '1,2,3,4,5') return 'Mon to Fri';
  return set.map((d) => DAY_LABELS[d]).join(', ');
};

function CustomReminders({ canEdit }) {
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // a draft, or null
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/push-reminders');
      setRows(data.reminders || []);
      setDepartments(data.departments || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load custom reminders');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true);
    try {
      if (editing._id) await api.put(`/push-reminders/${editing._id}`, editing);
      else await api.post('/push-reminders', editing);
      setEditing(null);
      await load();
      toast.success('Reminder saved — it applies from the next check.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r) => {
    const ok = await confirmDialog({
      title: 'Delete this reminder?',
      message: `“${r.title}” will stop being sent. This cannot be undone.`,
      confirmText: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/push-reminders/${r._id}`);
      await load();
      toast.success('Reminder deleted');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete');
    }
  };

  // Toggling enabled is a one-field save, so it does not open the editor.
  const toggle = async (r) => {
    try {
      await api.put(`/push-reminders/${r._id}`, { ...r, enabled: !r.enabled });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update');
    }
  };

  const setDay = (d) => setEditing((p) => ({
    ...p,
    days: p.days.includes(d) ? p.days.filter((x) => x !== d) : [...p.days, d].sort(),
  }));

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="card-title">Custom reminders</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Your own recurring pushes — a message, a time, and who gets it.
          </p>
        </div>
        {canEdit && !editing && (
          <button onClick={() => setEditing(blankCustom())}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 shrink-0">
            + Add reminder
          </button>
        )}
      </div>

      {editing && (
        <div className="bg-white shadow rounded-lg p-5 mb-4 border border-indigo-100">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-sm text-gray-700">Title *</label>
              <input value={editing.title} maxLength={80}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                placeholder="Submit your timesheet"
                className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
              <p className="text-[11px] text-gray-400 mt-1">This is the bold line of the push.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm text-gray-700">Message</label>
              <textarea value={editing.body} rows={2} maxLength={240}
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                placeholder="Before you leave today."
                className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
            </div>

            <div>
              <label className="block text-sm text-gray-700">Time (IST)</label>
              <input type="time" value={hhmm(editing)}
                onChange={(e) => {
                  const [h, m] = e.target.value.split(':').map(Number);
                  if (Number.isFinite(h) && Number.isFinite(m)) setEditing({ ...editing, hour: h, minute: m });
                }}
                className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
            </div>

            <div>
              <label className="block text-sm text-gray-700">Send to</label>
              <select value={editing.audience}
                onChange={(e) => setEditing({ ...editing, audience: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm">
                <option value="all">Everyone</option>
                <option value="department">One department</option>
              </select>
            </div>

            {editing.audience === 'department' && (
              <div>
                <label className="block text-sm text-gray-700">Department *</label>
                <select value={editing.department}
                  onChange={(e) => setEditing({ ...editing, department: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">Select…</option>
                  {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
            )}

            <div className="sm:col-span-2">
              <label className="block text-sm text-gray-700">Repeats on</label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {DAY_LABELS.map((label, d) => {
                  const on = editing.days.includes(d);
                  return (
                    <button key={d} type="button" onClick={() => setDay(d)}
                      className={`px-3 py-1.5 text-xs rounded-lg border ${on
                        ? 'bg-gray-900 text-white border-gray-900'
                        : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                      {label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                Select none for every day.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-4 mt-4 border-t border-gray-100">
            <button onClick={() => setEditing(null)}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={save} disabled={busy || !editing.title.trim()}
              className="ml-auto px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
              {busy ? 'Saving…' : 'Save reminder'}
            </button>
          </div>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reminder</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Time</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Repeats</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Audience</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Last sent</th>
              {canEdit && <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={canEdit ? 6 : 5} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={canEdit ? 6 : 5} className="px-4 py-6 text-center text-gray-500">
                No custom reminders yet.
              </td></tr>
            ) : rows.map((r) => (
              <tr key={r._id} className={r.enabled ? undefined : 'opacity-55'}>
                <td className="px-4 py-3">
                  <div className="font-medium">{r.title}</div>
                  {r.body ? <div className="text-xs text-gray-500 mt-0.5">{r.body}</div> : null}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{to12(r)}</td>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{daysLabel(r.days)}</td>
                <td className="px-4 py-3 text-gray-600">
                  {r.audience === 'department' ? r.department : 'Everyone'}
                </td>
                <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                  {r.lastSentAt
                    ? `${new Date(r.lastSentAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · ${r.lastSentCount}`
                    : '—'}
                </td>
                {canEdit && (
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button onClick={() => toggle(r)}
                      className="px-2.5 py-1 text-xs border rounded-lg hover:bg-gray-50 mr-1.5">
                      {r.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => setEditing({ ...r, days: r.days || [] })}
                      className="px-2.5 py-1 text-xs border rounded-lg hover:bg-gray-50 mr-1.5">Edit</button>
                    <button onClick={() => remove(r)}
                      className="px-2.5 py-1 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50">
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdminPushNotifications() {
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/attendance/settings');
      const cfg = data.attendanceReminders || {};
      const shaped = {};
      for (const r of REMINDERS) {
        const c = cfg[r.key] || {};
        shaped[r.key] = {
          enabled: c.enabled !== false,
          hour: Number.isInteger(c.hour) ? c.hour : r.defaults.hour,
          minute: Number.isInteger(c.minute) ? c.minute : r.defaults.minute,
        };
      }
      setForm(shaped);
      setSaved(JSON.stringify(shaped));
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the reminder settings');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const dirty = form && saved && JSON.stringify(form) !== saved;

  const setTime = (key, value) => {
    const [h, m] = String(value || '').split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return;
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], hour: h, minute: m } }));
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const { data } = await api.put('/attendance/settings', { attendanceReminders: form });
      const cfg = data.attendanceReminders || {};
      const shaped = {};
      for (const r of REMINDERS) {
        const c = cfg[r.key] || {};
        shaped[r.key] = { enabled: c.enabled !== false, hour: c.hour, minute: c.minute };
      }
      setForm(shaped);
      setSaved(JSON.stringify(shaped));
      toast.success('Reminder schedule updated — it applies from the next check.');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  // Ask everyone to install the current app build. A broadcast, because the
  // server records no per-device app version — anyone already up to date gets a
  // notification about something they have done, which is the lesser problem.
  const [nudging, setNudging] = useState(false);
  const nudgeUpdate = async () => {
    const ok = await confirmDialog({
      title: 'Ask everyone to update the app?',
      message: 'Everyone with the app installed gets a notification asking them to install the '
        + 'latest build. Phones already on it will simply find nothing to download.',
      confirmText: 'Send',
    });
    if (!ok) return;
    setNudging(true);
    try {
      const { data } = await api.post('/app/notify-update');
      toast.success(`Asked ${data.notified} ${data.notified === 1 ? 'person' : 'people'} to update to ${data.version}.`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not send that');
    } finally {
      setNudging(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Push Notification"
        subtitle="When the daily attendance reminders are pushed to the mobile app."
      >
        {isSuperAdmin && (
          <>
            <button onClick={nudgeUpdate} disabled={nudging}
              className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-60">
              {nudging ? 'Sending…' : 'Ask everyone to update the app'}
            </button>
            <button onClick={save} disabled={saving || !dirty || loading}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </PageHeader>

      {!isSuperAdmin && (
        <div className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
          Read-only — only a Super Admin can change the reminder schedule.
        </div>
      )}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {loading || !form ? (
        <div className="bg-white shadow rounded-lg p-6"><div className="skeleton h-4 rounded w-1/3" /></div>
      ) : (
        <div className="space-y-4">
          {REMINDERS.map((r) => {
            const v = form[r.key];
            return (
              <div key={r.key} className="bg-white shadow rounded-lg p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 max-w-2xl">
                    <h2 className="card-title">{r.label}</h2>
                    <p className="text-sm text-gray-500 mt-1">{r.blurb}</p>
                  </div>

                  <div className="flex items-center gap-4 shrink-0">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Time (IST)</label>
                      <input
                        type="time"
                        value={toInput(v)}
                        disabled={!isSuperAdmin || !v.enabled}
                        onChange={(e) => setTime(r.key, e.target.value)}
                        className="border rounded-lg px-3 py-2 text-sm disabled:opacity-50 disabled:bg-gray-50"
                      />
                      <div className="text-[11px] text-gray-400 mt-1">Fires at {to12(v)}</div>
                    </div>

                    <label className="flex items-center gap-2 text-sm text-gray-700 select-none cursor-pointer">
                      <input
                        type="checkbox"
                        checked={v.enabled}
                        disabled={!isSuperAdmin}
                        onChange={(e) => setForm((p) => ({ ...p, [r.key]: { ...p[r.key], enabled: e.target.checked } }))}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      Enabled
                    </label>
                  </div>
                </div>
              </div>
            );
          })}

          <p className="text-xs text-gray-500">
            Each reminder is sent at most once a day and only within 30 minutes of its scheduled time —
            so a server restart later in the day cannot replay a morning reminder. Times are IST.
          </p>

          <CustomReminders canEdit={isSuperAdmin} />
        </div>
      )}
    </div>
  );
}
