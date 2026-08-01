import { useEffect, useState } from 'react';
import { FiX, FiAward, FiStar } from 'react-icons/fi';
import api from '../api/client';
import AuthImage from './AuthImage';

// Initials fallback when a winner has no profile photo.
function initials(name) {
  const parts = (name || '').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '★';
}

// A round photo (protected avatar endpoint) with an initials fallback. The gold
// ring is drawn from the brand ramp so it reads on ivory and on near-black
// alike (Tailwind ring-* colours are literal and don't follow the dark theme).
function WinnerPhoto({ w, size = 64, ringWidth = 2 }) {
  const dim = { width: size, height: size };
  const ring = { boxShadow: `0 0 0 ${ringWidth}px var(--gold-500)` };
  const fallback = (
    <span className="inline-flex items-center justify-center rounded-full bg-amber-500 text-white font-semibold"
      style={{ ...dim, ...ring, fontSize: size * 0.36 }}>
      {initials(w.name)}
    </span>
  );
  if (!w.photo) return fallback;
  return (
    <AuthImage
      url={`/auth/users/${w.user}/avatar?p=${encodeURIComponent(w.photo)}`}
      alt={w.name}
      className="rounded-full object-cover"
      style={{ ...dim, ...ring }}
      fallback={fallback}
    />
  );
}

// Celebratory dashboard banner announcing the month's Rewards & Recognition
// winners. Shows for 2 working days after HR announces (server-enforced), and
// the employee can close it (per-user dismiss). Renders nothing when there's
// no live award for this viewer.
export default function RnrBanner() {
  const [award, setAward] = useState(null);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/rnr/current')
      .then(({ data }) => setAward(data.award || null))
      .catch(() => {});
  }, []);

  const dismiss = async () => {
    if (!award) return;
    setBusy(true);
    setClosed(true); // optimistic
    try {
      await api.post(`/rnr/${award._id}/dismiss`);
    } catch {
      setClosed(false);
    } finally {
      setBusy(false);
    }
  };

  if (!award || closed) return null;

  const eom = award.winners.find((w) => w.category === 'EmployeeOfMonth');
  const keyAchievers = award.winners.filter((w) => w.category === 'KeyAchiever');

  return (
    <div className="rnr-banner mb-4">
      <button
        type="button"
        onClick={dismiss}
        disabled={busy}
        aria-label="Dismiss"
        title="Dismiss"
        className="rnr-close absolute top-2.5 right-2.5 disabled:opacity-50 z-10"
      >
        <FiX size={18} />
      </button>

      <div className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <FiAward className="rnr-ink" size={20} />
          <h2 className="font-semibold text-gray-900">Rewards &amp; Recognition</h2>
          <span className="rnr-chip text-xs font-medium rounded-full px-2 py-0.5">
            {award.monthName} {award.year}
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Employee of the Month — the hero */}
          {eom && (
            <div className="rnr-card lg:col-span-1 p-4 flex items-center gap-4">
              <WinnerPhoto w={eom} size={72} ringWidth={2.5} />
              <div className="min-w-0">
                <div className="rnr-ink flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide">
                  <FiStar size={12} /> Employee of the Month
                </div>
                <div className="font-semibold text-gray-900 truncate">{eom.name}</div>
                <div className="text-xs text-gray-500 truncate">
                  {eom.designation || '-'}{eom.department ? ` · ${eom.department}` : ''}
                </div>
                {eom.citation && <div className="text-xs text-gray-600 mt-1 line-clamp-2">{eom.citation}</div>}
              </div>
            </div>
          )}

          {/* Key Achievers — one per department */}
          {keyAchievers.length > 0 && (
            <div className={`rnr-card-soft ${eom ? 'lg:col-span-2' : 'lg:col-span-3'} p-4`}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-3">
                Key Achievers by Department
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {keyAchievers.map((w) => (
                  <div key={String(w.user)} className="flex items-center gap-3">
                    <WinnerPhoto w={w} size={48} ringWidth={1.5} />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{w.name}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {w.department || '-'}{w.designation ? ` · ${w.designation}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
