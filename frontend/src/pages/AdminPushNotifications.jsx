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

  return (
    <div>
      <PageHeader
        title="Push Notification"
        subtitle="When the daily attendance reminders are pushed to the mobile app."
      >
        {isSuperAdmin && (
          <button onClick={save} disabled={saving || !dirty || loading}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
            {saving ? 'Saving…' : 'Save'}
          </button>
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
        </div>
      )}
    </div>
  );
}
