/**
 * AdminAuditLog — the portal-wide audit trail (admin portal, SuperAdmin only).
 *
 * REDESIGNED 2026-10-02 (user: "what log is this — mention proper", "add a
 * Details button", "make it more premium looking and user friendly"). Each
 * entry now reads as ONE SENTENCE the server writes ("Sequence Admin approved
 * Test User's leave request"), under a friendly module name, grouped by day,
 * with a colour-coded badge for where it ended up. "Details" opens a drawer
 * (components/audit/AuditDetail) with the change as Before → After, the record
 * it points at — found by id, even when another app wrote the row under a name
 * this portal does not use — and the record's whole history.
 *
 * The SuperAdmin can also DELETE entries, permanently — there is no bin:
 *   · tick rows → "Delete selected" (POST /audit/delete { ids });
 *   · one entry from its Details drawer (same endpoint);
 *   · "Delete all matching" takes every entry the filters match, not only the
 *     page on screen. It asks GET /audit/count for the real number first and
 *     hands that count's `asOf` back to POST /audit/purge, so exactly what the
 *     dialog promised is what goes. With no filters set it is "Delete entire
 *     log", and DELETE has to be typed out.
 * A deleted entry also drops out of the status histories built from the log
 * (the rest-day decision trail) — the dialogs say so.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiActivity, FiCalendar, FiUsers, FiDatabase, FiSearch, FiX, FiTrash2, FiRefreshCw, FiClock, FiChevronRight, FiShield,
} from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { useAuthStore } from '../store/authStore';
import { formatTime12 } from '../utils/time';
import AuditDetail, {
  Badge, ModuleChip, ActorAvatar, Sentence, isOtherApp,
} from '../components/audit/AuditDetail';
import {
  num, entries, dayText, dayHeading, fullStamp, byDay, roleHue, roleText, rangeFor,
} from '../components/audit/auditUtil';

// The list endpoint's default page; "showing the latest N" appears at it.
const PAGE = 200;

const RANGES = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'custom', label: 'Pick dates' },
];

const EMPTY_FILTERS = { entity: '', q: '', from: '', to: '' };

function Kpi({ icon: Icon, hue, label, value, sub, onClick, on }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`trn-kpi ${on ? 'is-on' : ''}`} onClick={onClick} aria-pressed={onClick ? !!on : undefined}>
      <span className="trn-kpi-icon" style={{ '--kpi-hue': hue }}><Icon size={19} /></span>
      <span className="min-w-0">
        <span className="trn-kpi-label block text-gray-600">{label}</span>
        <span className="trn-kpi-value block text-gray-900">{value}</span>
        {sub && <span className="trn-kpi-sub block text-gray-600">{sub}</span>}
      </span>
    </Tag>
  );
}

function EntryRow({ it, picked, onPick, onOpen }) {
  const otherApp = isOtherApp(it);
  return (
    // The row opens its Details on a click anywhere (a convenience for the
    // mouse); the real control — keyboard and screen reader — is the Details
    // button, so no interactive element sits inside another.
    <div className={`aud-row ${picked ? 'is-picked' : ''}`} onClick={onOpen}>
      <label className="aud-pick" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Select: ${it.summary}`} />
      </label>
      <ActorAvatar name={it.byName} role={it.byRole} />
      <div className="aud-main">
        <p className="aud-sentence text-gray-700"><Sentence entry={it} /></p>
        <div className="aud-meta text-gray-500">
          <span className="aud-time" title={fullStamp(it.at)}><FiClock size={12} />{formatTime12(it.at)}</span>
          {it.byName && <span className="aud-role" style={{ '--hue': roleHue(it.byRole) }}>{roleText(it.byRole)}</span>}
          <ModuleChip label={it.moduleLabel || it.entity} otherApp={otherApp} />
        </div>
      </div>
      <div className="aud-side">
        <Badge badge={it.badge} />
        <button type="button" className="trn-btn aud-details-btn" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          Details <FiChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

export default function AdminAuditLog() {
  // SuperAdmin-only (the backend 403s everyone else). Without this gate the page
  // rendered its whole filter UI and surfaced the raw "Not authorised" error to
  // HR Managers — the sidebar already hides it, so show the same clean gate the
  // other SuperAdmin-only tools use (Chat Export, Permissions).
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [items, setItems] = useState([]);
  const [modules, setModules] = useState([]);
  const [stats, setStats] = useState(null);
  // `loading` is the FIRST load only (skeleton); every later fetch is
  // `refreshing` and leaves the list where it is (layout stability).
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [range, setRange] = useState('all');
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  const [openId, setOpenId] = useState(null);
  // Filters move a keystroke at a time and a post-delete reload can overlap a
  // filter load, so only the newest request is allowed to write to state.
  const reqId = useRef(0);
  const loaded = useRef(false);
  // The headline counts ride along with a list request until one lands — a
  // request that carried them and then lost the race asks again next time.
  const needStats = useRef(true);

  // The filters actually in force, trimmed, as request params. The list, the
  // count and the purge all send exactly this, so they can never disagree about
  // what "matching" means — a search of only spaces is no filter to any of them.
  const activeParams = () => {
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { const t = String(v || '').trim(); if (t) params[k] = t; });
    return params;
  };
  const filtersActive = Object.keys(activeParams()).length > 0;

  const load = async () => {
    if (!isSuperAdmin) { setLoading(false); return; }
    const mine = ++reqId.current;
    const withStats = needStats.current;
    if (loaded.current) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/audit', { params: { ...activeParams(), ...(withStats ? { stats: '1' } : {}) } });
      if (mine !== reqId.current) return;
      loaded.current = true;
      setItems(data.items);
      setModules(data.modules || (data.entities || []).map((v) => ({ value: v, label: v, known: true })));
      if (data.stats) { setStats(data.stats); needStats.current = false; }
      // A selection only ever names rows on screen: anything that has left the
      // list (filtered away, or deleted) is let go, so "Delete selected" can
      // never reach a row nobody is looking at.
      const onScreen = new Set(data.items.map((it) => it._id));
      setSelected((sel) => new Set([...sel].filter((id) => onScreen.has(id))));
    } catch (err) {
      if (mine !== reqId.current) return;
      setError(err.response?.data?.message || 'Failed to load audit log');
    } finally {
      if (mine === reqId.current) { setLoading(false); setRefreshing(false); }
    }
  };
  // Reload when filters change (debounced lightly for the text box).
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [filters]);

  const reloadAll = () => { needStats.current = true; load(); };

  const setFilter = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  const pickRange = (id) => {
    setRange(id);
    if (id !== 'custom') setFilters((f) => ({ ...f, ...rangeFor(id) }));
  };
  const clearFilters = () => { setRange('all'); setFilters(EMPTY_FILTERS); };

  const moduleLabel = (value) => modules.find((m) => m.value === value)?.label || value;
  const groups = useMemo(() => byDay(items), [items]);

  const toggle = (id) => setSelected((sel) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = items.length > 0 && items.every((it) => selected.has(it._id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((it) => it._id)));

  /** Delete the given ids after a confirmation; true when they went. */
  const deleteIds = async (ids) => {
    if (!ids.length) return false;
    const ok = await confirmDialog({
      title: ids.length === 1 ? 'Delete this entry permanently?' : `Delete ${entries(ids.length)} permanently?`,
      message: `${ids.length === 1 ? 'It is' : 'They are'} removed from the audit log for good, along with the steps `
        + `${ids.length === 1 ? 'it adds' : 'they add'} to any status history (rest-day decisions). This cannot be undone.`,
      confirmText: 'Delete permanently',
      tone: 'danger',
    });
    if (!ok) return false;
    setDeleting(true);
    try {
      const { data } = await api.post('/audit/delete', { ids });
      if (data.deleted) toast.success(`Deleted ${entries(data.deleted)}.`);
      else toast.info('Nothing was deleted — those entries were already gone.');
      // Off the screen at once; the quiet reload then tops the page back up.
      const gone = new Set(ids);
      setItems((list) => list.filter((it) => !gone.has(it._id)));
      setSelected((sel) => new Set([...sel].filter((id) => !gone.has(id))));
      reloadAll();
      return true;
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete those entries');
      return false;
    } finally {
      setDeleting(false);
    }
  };

  const deleteSelected = () => deleteIds(items.filter((it) => selected.has(it._id)).map((it) => it._id));
  const deleteOne = async (id) => { if (await deleteIds([id])) setOpenId(null); };

  const deleteMatching = async () => {
    const params = activeParams();
    const narrowed = Object.keys(params).length > 0;

    // The list stops at 200, so the real number comes from the server — and its
    // `asOf` goes back with the purge, so entries written while the dialog is
    // open are not swept up in a count that never included them.
    let count;
    let asOf;
    setDeleting(true);
    try {
      ({ data: { count, asOf } } = await api.get('/audit/count', { params }));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not count the matching entries');
      return;
    } finally {
      setDeleting(false);
    }
    if (!count) {
      toast.info(narrowed ? 'Nothing matches these filters — there is nothing to delete.' : 'The audit log is already empty.');
      return;
    }

    if (narrowed) {
      const ok = await confirmDialog({
        title: count === 1 ? 'Delete the 1 matching entry?' : `Delete all ${num(count)} matching entries?`,
        message: 'Every entry matching these filters is deleted permanently — not only the ones on '
          + 'this page. This cannot be undone.',
        details: [
          params.entity && `Module: ${moduleLabel(params.entity)}`,
          params.q && `Search: “${params.q}”`,
          params.from && `From ${dayText(params.from)}`,
          params.to && `To ${dayText(params.to)}`,
        ].filter(Boolean),
        confirmText: 'Delete permanently',
        tone: 'danger',
      });
      if (!ok) return;
    } else {
      // Emptying the whole log is the one delete that has to be typed out.
      const typed = await promptDialog({
        title: 'Delete the entire audit log?',
        message: `${count === 1 ? 'The log’s only entry' : `All ${entries(count)}, across every module,`} `
          + 'will be deleted permanently. This cannot be undone.',
        inputLabel: 'Type DELETE to confirm',
        placeholder: 'DELETE',
        confirmText: 'Delete everything',
        tone: 'danger',
      });
      if (typed == null) return;
      if (typed.trim().toUpperCase() !== 'DELETE') {
        toast.info('Nothing was deleted — type DELETE to confirm.');
        return;
      }
    }

    setDeleting(true);
    try {
      const { data } = await api.post('/audit/purge', { ...params, asOf, everything: !narrowed });
      if (data.deleted) toast.success(`Deleted ${entries(data.deleted)}.`);
      else toast.info('Nothing was deleted — those entries were already gone.');
      setSelected(new Set());
      reloadAll();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete the entries');
    } finally {
      setDeleting(false);
    }
  };

  const subtitle = 'Every change across the portal, in plain words — who did what, and when';

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Audit Log" subtitle={subtitle} />
        <div className="trn-card-base trn-empty">
          <span className="trn-empty-icon"><FiShield size={24} /></span>
          <p className="text-gray-600">This tool isn&apos;t available for your account.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Audit Log" subtitle={subtitle}>
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        <button type="button" className="trn-btn" onClick={reloadAll} disabled={loading || refreshing}>
          <FiRefreshCw size={14} /> Refresh
        </button>
        <button type="button" className="trn-btn is-danger" onClick={deleteMatching} disabled={deleting || loading || items.length === 0}
          title={filtersActive
            ? 'Permanently delete every entry these filters match — not only this page'
            : 'Permanently delete every entry in the audit log'}>
          <FiTrash2 size={14} /> {filtersActive ? 'Delete all matching' : 'Delete entire log'}
        </button>
      </PageHeader>

      <div className="trn-kpis mb-4">
        <Kpi icon={FiActivity} hue="#2563eb" label="Today" value={stats ? num(stats.today) : '—'} sub="since midnight"
          onClick={() => pickRange(range === 'today' ? 'all' : 'today')} on={range === 'today'} />
        <Kpi icon={FiCalendar} hue="#7c3aed" label="Last 7 days" value={stats ? num(stats.week) : '—'} sub="changes"
          onClick={() => pickRange(range === '7d' ? 'all' : '7d')} on={range === '7d'} />
        <Kpi icon={FiUsers} hue="#0d9488" label="People" value={stats ? num(stats.people) : '—'} sub="active in 7 days" />
        <Kpi icon={FiDatabase} hue="#d97706" label="Whole log" value={stats ? num(stats.total) : '—'} sub="entries kept"
          onClick={clearFilters} on={!filtersActive} />
      </div>

      <div className="trn-card-base trn-toolbar aud-toolbar mb-3">
        <label className="trn-search text-gray-700">
          <FiSearch size={15} className="shrink-0 text-gray-400" />
          <input value={filters.q} onChange={setFilter('q')} placeholder="Search a person, record or status…" aria-label="Search the audit log" />
          {filters.q && (
            <button type="button" className="aud-clear text-gray-400" onClick={() => setFilters((f) => ({ ...f, q: '' }))} aria-label="Clear search"><FiX size={14} /></button>
          )}
        </label>
        <div className="aud-module-pick">
          <SearchableSelect value={filters.entity} onChange={setFilter('entity')} className="trn-select w-full" aria-label="Module">
            <option value="">All modules</option>
            {modules.map((m) => <option key={m.value} value={m.value}>{m.known ? m.label : `${m.label} (another app)`}</option>)}
          </SearchableSelect>
        </div>
        <div className="trn-seg" role="group" aria-label="When">
          {RANGES.map((r) => (
            <button key={r.id} type="button" className={`trn-seg-btn ${range === r.id ? 'is-on' : ''}`} onClick={() => pickRange(r.id)} aria-pressed={range === r.id}>
              {r.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="aud-dates text-gray-600">
            <input type="date" className="trn-select" value={filters.from} max={filters.to || undefined} onChange={setFilter('from')} aria-label="From date" />
            <span className="text-xs">to</span>
            <input type="date" className="trn-select" value={filters.to} min={filters.from || undefined} onChange={setFilter('to')} aria-label="To date" />
          </div>
        )}
        {filtersActive && (
          <button type="button" className="trn-btn" onClick={clearFilters}><FiX size={14} /> Clear filters</button>
        )}
      </div>

      <div className="aud-bar text-gray-600">
        <label className="aud-all">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={loading || items.length === 0}
            // Part of the page ticked shows as a dash, not as an empty box.
            ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }} />
          <span>{selected.size ? `${num(selected.size)} selected` : 'Select all'}</span>
        </label>
        <span className="aud-bar-count">
          {loading ? 'Loading…' : items.length >= PAGE ? `Latest ${num(items.length)} entries` : entries(items.length)}
          {filtersActive && !loading ? ' match' : ''}
        </span>
        {selected.size > 0 && (
          <button type="button" className="trn-btn is-danger ml-auto" onClick={deleteSelected} disabled={deleting}>
            <FiTrash2 size={14} /> Delete selected ({num(selected.size)})
          </button>
        )}
      </div>

      {error && <div className="trn-note is-warn text-gray-700 mb-3">{error}</div>}

      {loading ? (
        <div className="trn-card-base aud-list">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="aud-row is-skeleton">
              <span />
              <div className="skeleton rounded-full" style={{ width: '2.35rem', height: '2.35rem' }} />
              <div className="space-y-2"><div className="skeleton h-4 rounded w-4/5" /><div className="skeleton h-3 rounded w-2/5" /></div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="trn-card-base trn-empty">
          <span className="trn-empty-icon"><FiShield size={24} /></span>
          <p className="font-semibold text-gray-800">{filtersActive ? 'Nothing matches these filters' : 'No changes recorded yet'}</p>
          <p className="text-sm text-gray-500 max-w-sm">
            {filtersActive ? 'Try another module, a wider date range or a shorter search.' : 'Approvals, status moves and edits across the portal will appear here as they happen.'}
          </p>
          {filtersActive && <button type="button" className="trn-btn" onClick={clearFilters}><FiX size={14} /> Clear filters</button>}
        </div>
      ) : (
        <div className={refreshing ? 'aud-refreshing' : undefined}>
          {groups.map((g) => (
            <section key={g.key} className="aud-day">
              <div className="aud-day-head">
                <span className="aud-day-title text-gray-700">{dayHeading(g.at)}</span>
                <span className="aud-day-sub text-gray-500">{entries(g.items.length)}</span>
              </div>
              <div className="trn-card-base aud-list">
                {g.items.map((it) => (
                  <EntryRow key={it._id} it={it} picked={selected.has(it._id)} onPick={() => toggle(it._id)} onOpen={() => setOpenId(it._id)} />
                ))}
              </div>
            </section>
          ))}
          {items.length >= PAGE && (
            <p className="text-xs text-gray-500 mt-3 px-1">Showing the latest {num(PAGE)} changes · narrow the filters to reach older ones.</p>
          )}
        </div>
      )}

      {openId && (
        <AuditDetail
          entryId={openId}
          preview={items.find((it) => it._id === openId)}
          onClose={() => setOpenId(null)}
          onDelete={deleteOne}
          deleting={deleting}
        />
      )}
    </div>
  );
}
