import { useEffect, useState } from 'react';
import api from '../api/client';
import { FiAward, FiCheck, FiHeart, FiHome } from 'react-icons/fi';
import { TbCake, TbBalloon } from 'react-icons/tb';
import { useAuthStore } from '../store/authStore';

// SmartHR-style "Birthdays & Celebrations" widget with a Send-a-wish action.
// Self-contained: fetches today + the next 30 days of birthdays / work
// anniversaries and lets the viewer send an in-app + email greeting.
//
// Only the first PREVIEW_COUNT are shown; the rest sit behind "See all", which
// opens a scrolling list rather than letting the card run down the page.
//
// The cake / award pair carries the same birthday-vs-anniversary distinction the
// 🎂/🎊 emoji used to, but as stroke icons they inherit the ink of whatever they
// sit on (a dark button, an amber heading) instead of fighting it.

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
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

// Everything that differs per occasion, in one place — adding a fourth type is
// then a single entry rather than another ternary in five spots.
const OCCASION = {
  birthday: { avatar: 'bg-amber-500', chip: 'bg-amber-100 text-amber-800', Icon: TbCake, noun: 'birthday', label: () => 'Birthday' },
  anniversary: { avatar: 'bg-blue-500', chip: 'bg-blue-100 text-blue-800', Icon: FiAward, noun: 'work anniversary', label: (e) => `${ordinal(e.years)} Work Anniversary` },
  marriage: { avatar: 'bg-rose-500', chip: 'bg-rose-100 text-rose-800', Icon: FiHeart, noun: 'wedding anniversary', label: (e) => `${ordinal(e.years)} Wedding Anniversary` },
  // The company's own foundation day. `wishable: false` because there is no
  // person on the other end of it — the row is an announcement, not an action.
  company: {
    avatar: 'bg-teal-600', chip: 'bg-teal-100 text-teal-800', Icon: FiHome,
    noun: 'company anniversary', wishable: false,
    label: (e) => `${ordinal(e.years)} Company Anniversary`,
  },
};
const occasionOf = (e) => OCCASION[e.type] || OCCASION.birthday;

// How many rows the card shows before "See all" is offered.
const PREVIEW_COUNT = 5;

export default function BirthdayWisher({ myEmployeeId, days = 30, months }) {
  // Read from the store rather than a prop: the admin dashboard renders this
  // with no props at all, and an exec row needs a self-check the profile id
  // cannot give (a CEO/MD has no employee profile).
  const me = useAuthStore((s) => s.user);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState({});
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // Rolling 30 days by default. A two-month calendar window listed people
        // 50+ days out, which made the card taller than the page it sits on;
        // `months` is still honoured for any caller that explicitly wants it.
        const q = months ? `months=${months}` : `days=${days}`;
        const { data } = await api.get(`/celebrations/upcoming?${q}`);
        setEvents(data.events || []);
      } catch {
        // Quietly degrade — widget just shows empty.
      } finally {
        setLoading(false);
      }
    })();
  }, [days, months]);

  // Collapsed by default; expanding scrolls inside the card instead of growing it.
  const visible = showAll ? events : events.slice(0, PREVIEW_COUNT);
  const hiddenCount = events.length - visible.length;

  // Three kinds of row now share this list: staff (profile id), an executive
  // (user id — they have no profile) and a company (company id).
  const keyOf = (e) => `${e.employeeId || e.userId || e.companyId}-${e.type}`;
  const isMe = (e) => {
    if (e.userId && me?._id) return String(e.userId) === String(me._id);
    return !!(myEmployeeId && e.employeeId && String(e.employeeId) === String(myEmployeeId));
  };

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
        // An exec has no profile, so the server takes their user id instead.
        ...(e.employeeId ? { employeeId: e.employeeId } : { userId: e.userId }),
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
          <TbCake className="text-amber-500 shrink-0" aria-hidden="true" />
          Birthdays &amp; Celebrations
        </h2>
        <span className="text-xs text-gray-500">{events.length} upcoming</span>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 italic">Loading…</p>
      ) : events.length === 0 ? (
        <div className="text-center py-6">
          <TbBalloon size={30} className="mx-auto mb-1.5 text-gray-300" aria-hidden="true" />
          <p className="text-sm text-gray-400 italic">
            {months
              ? 'No birthdays or anniversaries this month or next.'
              : `No celebrations in the next ${days} days.`}
          </p>
        </div>
      ) : (
        <>
        <ul className={`space-y-2${showAll ? ' max-h-96 overflow-y-auto pr-1' : ''}`}>
          {visible.map((e) => {
            const k = keyOf(e);
            const occ = occasionOf(e);
            const isSelf = isMe(e);
            const wished = sent[k];
            // A company anniversary has nobody to wish — the row just says so.
            const canWish = occ.wishable !== false;
            return (
              <li key={k} className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                {/* The row wraps in one place, so a narrow card gets a second
                    line instead of overlapping text. `min-w-[9rem]` on the
                    person column is what triggers it: below roughly 420px the
                    when + action cluster no longer fits beside a 9rem column
                    and drops underneath, where it right-aligns via ml-auto. */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className={`avatar-circle text-white ${occ.avatar}`}>
                    {initials(e.fullName)}
                  </span>
                  <div className="min-w-0 flex-1 basis-36">
                    {/* Wraps rather than truncates: the name and the chip used to
                        share one `truncate` line, so on a phone a long name ate
                        the ellipsis AND the occasion — the one word that says
                        what is being celebrated. The chip now drops to its own
                        line when it cannot sit beside the name. */}
                    <div className="text-sm font-medium text-gray-900 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate min-w-0 max-w-full">{e.fullName}</span>
                      <span className={`shrink-0 inline-block px-2 py-0.5 text-[11px] rounded-full ${occ.chip}`}>
                        {occ.label(e)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {(e.designation || '-')}{e.department ? ` · ${e.department}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-auto">
                    <span className="text-xs text-gray-500 shrink-0">{whenLabel(e.daysAway)}</span>
                    {!canWish ? (
                      <span className="text-xs text-gray-400 italic shrink-0">Everyone</span>
                    ) : isSelf ? (
                      <span className="text-xs text-gray-400 italic shrink-0">That&apos;s you</span>
                    ) : wished ? (
                      <span className="text-xs text-green-600 font-medium shrink-0 inline-flex items-center gap-1">
                        <FiCheck aria-hidden="true" /> Wish sent
                      </span>
                    ) : (
                      <button
                        onClick={() => (openKey === k ? setOpenKey(null) : openComposer(e))}
                        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-900 text-white rounded-lg hover:bg-gray-700"
                      >
                        <occ.Icon size={14} aria-hidden="true" />
                        Wish
                      </button>
                    )}
                  </div>
                </div>

                {openKey === k && canWish && !isSelf && !wished && (
                  <div className="mt-3 pl-12">
                    <textarea
                      rows={2}
                      value={message}
                      onChange={(ev) => setMessage(ev.target.value)}
                      maxLength={280}
                      placeholder={`Write a ${occ.noun} note for ${e.firstName || e.fullName}… (optional)`}
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
        {(hiddenCount > 0 || showAll) && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 w-full text-center text-xs font-medium text-gray-600 hover:text-gray-900 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"
          >
            {showAll ? 'Show less' : `See all ${events.length}`}
          </button>
        )}
        </>
      )}
    </div>
  );
}
