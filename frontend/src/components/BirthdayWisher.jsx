import { useEffect, useState } from 'react';
import api from '../api/client';

// SmartHR-style "Birthdays & Celebrations" widget with a Send-a-wish action.
// Self-contained: fetches today + the next 7 days of birthdays / work
// anniversaries and lets the viewer send an in-app + email greeting.

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function whenLabel(daysAway) {
  if (daysAway === 0) return 'Today';
  if (daysAway === 1) return 'Tomorrow';
  return `In ${daysAway} days`;
}

function initials(name) {
  const parts = (name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '🎉';
}

export default function BirthdayWisher({ myEmployeeId, days = 7 }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState({});
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // /upcoming includes daysAway 0 (today) through `days`.
        const { data } = await api.get(`/celebrations/upcoming?days=${days}`);
        setEvents(data.events || []);
      } catch {
        // Quietly degrade — widget just shows empty.
      } finally {
        setLoading(false);
      }
    })();
  }, [days]);

  const keyOf = (e) => `${e.employeeId}-${e.type}`;

  const openComposer = (e) => {
    setOpenKey(keyOf(e));
    setMessage('');
    setError('');
  };

  const send = async (e) => {
    setSending(true);
    setError('');
    try {
      await api.post('/celebrations/wish', {
        employeeId: e.employeeId,
        type: e.type,
        message: message.trim() || undefined,
      });
      setSent((prev) => ({ ...prev, [keyOf(e)]: true }));
      setOpenKey(null);
      setMessage('');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send wish');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="bg-white shadow rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="card-title flex items-center gap-2">
          <span>🎂</span> Birthdays &amp; Celebrations
        </h2>
        <span className="text-xs text-gray-500">{events.length} upcoming</span>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 italic">Loading…</p>
      ) : events.length === 0 ? (
        <div className="text-center py-6">
          <div className="text-3xl mb-1">🎈</div>
          <p className="text-sm text-gray-400 italic">No birthdays or anniversaries in the next {days} days.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => {
            const k = keyOf(e);
            const isBirthday = e.type === 'birthday';
            const isSelf = myEmployeeId && String(e.employeeId) === String(myEmployeeId);
            const wished = sent[k];
            return (
              <li key={k} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                <div className="flex items-center gap-3">
                  <span className={`avatar-circle text-white ${isBirthday ? 'bg-amber-500' : 'bg-blue-500'}`}>
                    {initials(e.fullName)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {e.fullName}
                      <span className={`ml-2 inline-block px-2 py-0.5 text-[11px] rounded-full ${
                        isBirthday ? 'bg-amber-100 text-amber-800' : 'bg-blue-100 text-blue-800'
                      }`}>
                        {isBirthday ? 'Birthday' : `${ordinal(e.years)} Anniversary`}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {(e.designation || '-')}{e.department ? ` · ${e.department}` : ''}
                    </div>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0">{whenLabel(e.daysAway)}</span>
                  {isSelf ? (
                    <span className="text-xs text-gray-400 italic shrink-0">That's you 🎉</span>
                  ) : wished ? (
                    <span className="text-xs text-green-600 font-medium shrink-0">Wish sent ✓</span>
                  ) : (
                    <button
                      onClick={() => (openKey === k ? setOpenKey(null) : openComposer(e))}
                      className="shrink-0 px-3 py-1.5 text-xs bg-gray-900 text-white rounded-lg hover:bg-gray-700"
                    >
                      {isBirthday ? 'Wish 🎉' : 'Wish 🎊'}
                    </button>
                  )}
                </div>

                {openKey === k && !isSelf && !wished && (
                  <div className="mt-3 pl-12">
                    <textarea
                      rows={2}
                      value={message}
                      onChange={(ev) => setMessage(ev.target.value)}
                      maxLength={280}
                      placeholder={isBirthday
                        ? `Write a birthday message for ${e.firstName || e.fullName}… (optional)`
                        : `Write an anniversary note for ${e.firstName || e.fullName}… (optional)`}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    {error && <div className="text-xs text-red-600 mt-1">{error}</div>}
                    <div className="flex justify-end gap-2 mt-2">
                      <button onClick={() => setOpenKey(null)}
                        className="px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-50">Cancel</button>
                      <button onClick={() => send(e)} disabled={sending}
                        className="px-3 py-1.5 text-xs bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                        {sending ? 'Sending…' : 'Send wish'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
