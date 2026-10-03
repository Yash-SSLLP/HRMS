/**
 * Who is attending — a searchable, department-grouped tick list.
 *
 * Replaces the bare multi-select the form used to have. Booking "all of Sales"
 * meant ticking twelve names one by one; now a department chip narrows the list
 * and "Select all shown" ticks it in one go. Everyone chosen sits above the
 * list as a removable chip, so a long list can never hide somebody who IS on
 * the training.
 *
 * Executives (CEO/MD) have no employee profile, so they are left out of this
 * list unless the SuperAdmin's org switch puts them in lists
 * (`includeExecutives`, from GET /training/people) — or they are already on
 * this training, in which case they stay visible so they can be removed.
 *
 * `known` maps id → person for anyone already on the training who is no longer
 * in the people list (deactivated, or since left), so their chip still has a
 * name instead of an id.
 */
import { useMemo, useState } from 'react';
import { FiSearch, FiCheck, FiX, FiUsers } from 'react-icons/fi';
import { fullName, initials } from './trainingUtil';

const EXEC_ROLES = ['CEO', 'MD'];
const MAX_ROWS = 300;
const CHIP_PREVIEW = 14;

export default function ParticipantPicker({ people = [], value = [], onChange, includeExecutives = false, known = {} }) {
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [showAllChips, setShowAllChips] = useState(false);
  const selected = useMemo(() => new Set(value.map(String)), [value]);

  // Who may be offered at all.
  const pool = useMemo(() => people.filter((p) => includeExecutives
    || !EXEC_ROLES.includes(p.role) || selected.has(String(p._id))), [people, includeExecutives, selected]);

  const depts = useMemo(() => {
    const m = new Map();
    pool.forEach((p) => { const d = p.department || 'No department'; m.set(d, (m.get(d) || 0) + 1); });
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [pool]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return pool.filter((p) => {
      if (dept && (p.department || 'No department') !== dept) return false;
      if (!s) return true;
      return `${fullName(p)} ${p.employeeCode || ''} ${p.designation || ''} ${p.department || ''} ${p.email || ''}`
        .toLowerCase().includes(s);
    });
  }, [pool, q, dept]);

  const byId = useMemo(() => {
    const m = new Map(Object.entries(known || {}).map(([k, v]) => [String(k), v]));
    people.forEach((p) => m.set(String(p._id), p));
    return m;
  }, [people, known]);

  const toggle = (id) => {
    const k = String(id);
    onChange(selected.has(k) ? value.filter((v) => String(v) !== k) : [...value.map(String), k]);
  };
  const shownIds = shown.map((p) => String(p._id));
  const allShownOn = shownIds.length > 0 && shownIds.every((id) => selected.has(id));
  const selectShown = () => {
    if (allShownOn) onChange(value.filter((v) => !shownIds.includes(String(v))));
    else onChange([...new Set([...value.map(String), ...shownIds])]);
  };

  const chips = value.map(String);
  const visibleChips = showAllChips ? chips : chips.slice(0, CHIP_PREVIEW);

  return (
    <div className="trn-picker">
      <div className="trn-picker-top">
        <div className="flex flex-wrap gap-2">
          <label className="trn-search" style={{ flexBasis: '16rem' }}>
            <FiSearch size={15} className="text-gray-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, code, designation…" aria-label="Search people" />
            {q && <button type="button" className="text-gray-400" onClick={() => setQ('')} aria-label="Clear search"><FiX size={14} /></button>}
          </label>
          <button type="button" className="trn-btn" onClick={selectShown} disabled={!shownIds.length}>
            <FiCheck size={14} /> {allShownOn ? 'Unselect shown' : `Select all shown (${shownIds.length})`}
          </button>
        </div>
        {depts.length > 1 && (
          <div className="trn-depts" role="group" aria-label="Filter by department">
            <button type="button" className={`trn-dept ${!dept ? 'is-on' : ''}`} onClick={() => setDept('')}>
              Everyone <span className="trn-dept-n">{pool.length}</span>
            </button>
            {depts.map(([d, n]) => (
              <button key={d} type="button" className={`trn-dept ${dept === d ? 'is-on' : ''}`} onClick={() => setDept(dept === d ? '' : d)}>
                {d} <span className="trn-dept-n">{n}</span>
              </button>
            ))}
          </div>
        )}
        {chips.length > 0 && (
          <div className="trn-picked">
            {visibleChips.map((id) => {
              const p = byId.get(id);
              return (
                <span key={id} className="trn-pill-x text-gray-800">
                  <span className="truncate">{p ? fullName(p) : 'Former employee'}</span>
                  <button type="button" onClick={() => toggle(id)} aria-label={`Remove ${p ? fullName(p) : 'person'}`}><FiX size={12} /></button>
                </span>
              );
            })}
            {chips.length > CHIP_PREVIEW && (
              <button type="button" className="text-xs font-semibold accent-text px-2" onClick={() => setShowAllChips((s) => !s)}>
                {showAllChips ? 'Show fewer' : `+${chips.length - CHIP_PREVIEW} more`}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="trn-pick-list">
        {shown.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">
            {pool.length ? 'Nobody matches that search.' : 'No active staff to choose from.'}
          </div>
        ) : shown.slice(0, MAX_ROWS).map((p) => {
          const on = selected.has(String(p._id));
          const sub = [p.employeeCode, p.designation, p.department].filter(Boolean).join(' · ') || p.email || p.role;
          return (
            <button key={p._id} type="button" className={`trn-pick-row ${on ? 'is-on' : ''}`} onClick={() => toggle(p._id)} aria-pressed={on}>
              <span className="trn-check"><FiCheck size={12} strokeWidth={3} /></span>
              <span className="trn-av">{initials(fullName(p))}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-gray-900">{fullName(p)}</span>
                <span className="block truncate text-xs text-gray-500">{sub}</span>
              </span>
            </button>
          );
        })}
        {shown.length > MAX_ROWS && (
          <div className="px-4 py-3 text-center text-xs text-gray-500">{shown.length - MAX_ROWS} more</div>
        )}
      </div>

      <div className="trn-pick-foot text-gray-600">
        <span className="inline-flex items-center gap-1.5"><FiUsers size={13} /> <b className="text-gray-900">{chips.length}</b> selected</span>
        {chips.length > 0 && (
          <button type="button" className="text-xs font-semibold text-red-600" onClick={() => onChange([])}>Clear all</button>
        )}
      </div>
    </div>
  );
}
