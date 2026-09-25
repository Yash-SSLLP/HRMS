/**
 * AdminAuditLog — portal-wide status-change audit trail (admin portal). Loads
 * entries (who changed what status, when) from GET /audit with module/search/date
 * filters; the endpoint also returns the list of distinct modules for the filter.
 *
 * The SuperAdmin can also DELETE entries, permanently — there is no bin:
 *   · tick rows → "Delete selected" (POST /audit/delete { ids });
 *   · "Delete all matching" takes every entry the filters match, not only the
 *     page on screen. It asks GET /audit/count for the real number first and
 *     hands that count's `asOf` back to POST /audit/purge, so exactly what the
 *     dialog promised is what goes. With no filters set it is "Delete entire
 *     log", and DELETE has to be typed out.
 * A deleted entry also drops out of the status histories built from the log
 * (expense-claim History, the rest-day decision trail) — the dialogs say so.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { useAuthStore } from '../store/authStore';
import { formatDateTime12 } from '../utils/time';

const fmt = (d) => formatDateTime12(d) || '-';

const num = (n) => Number(n).toLocaleString('en-IN');
// "1 entry" / "1,204 entries".
const entries = (n) => `${num(n)} ${n === 1 ? 'entry' : 'entries'}`;

// A filter date ("2026-09-01") the way the confirmation spells it out.
const day = (ymd) => new Date(`${ymd}T00:00:00`)
  .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

const ROLE_STYLES = {
  SuperAdmin: 'bg-violet-100 text-violet-800',
  HRManager: 'bg-teal-100 text-teal-800',
  Employee: 'bg-blue-100 text-blue-800',
};

export default function AdminAuditLog() {
  // SuperAdmin-only (the backend 403s everyone else). Without this gate the page
  // rendered its whole filter UI and surfaced the raw "Not authorised" error to
  // HR Managers — the sidebar already hides it, so show the same clean gate the
  // other SuperAdmin-only tools use (Chat Export, Permissions).
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [items, setItems] = useState([]);
  const [entities, setEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ entity: '', q: '', from: '', to: '' });
  const [selected, setSelected] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);
  // Filters move a keystroke at a time and a post-delete reload can overlap a
  // filter load, so only the newest request is allowed to write to state.
  const reqId = useRef(0);

  // The filters actually in force, trimmed, as request params. The list, the
  // count and the purge all send exactly this, so they can never disagree about
  // what "matching" means — a search of only spaces is no filter to any of them.
  const activeParams = () => {
    const params = {};
    Object.entries(filters).forEach(([k, v]) => { const t = String(v || '').trim(); if (t) params[k] = t; });
    return params;
  };
  const filtersActive = Object.keys(activeParams()).length > 0;

  const load = async ({ quiet = false } = {}) => {
    if (!isSuperAdmin) { setLoading(false); return; }
    const mine = ++reqId.current;
    if (!quiet) setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/audit', { params: activeParams() });
      if (mine !== reqId.current) return;
      setItems(data.items);
      setEntities(data.entities);
      // A selection only ever names rows on screen: anything that has left the
      // list (filtered away, or deleted) is let go, so "Delete selected" can
      // never reach a row nobody is looking at.
      const onScreen = new Set(data.items.map((it) => it._id));
      setSelected((sel) => new Set([...sel].filter((id) => onScreen.has(id))));
    } catch (err) {
      if (mine !== reqId.current) return;
      setError(err.response?.data?.message || 'Failed to load audit log');
    } finally {
      if (mine === reqId.current) setLoading(false);
    }
  };
  // Reload when filters change (debounced lightly for the text box).
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, [filters]);

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  const toggle = (id) => setSelected((sel) => {
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = items.length > 0 && items.every((it) => selected.has(it._id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(items.map((it) => it._id)));

  const deleteSelected = async () => {
    const ids = items.filter((it) => selected.has(it._id)).map((it) => it._id);
    if (!ids.length) return;
    const ok = await confirmDialog({
      title: `Delete ${entries(ids.length)} permanently?`,
      message: 'They are removed from the audit log for good, along with the steps they add to any '
        + 'status history (expense claims, rest-day decisions). This cannot be undone.',
      confirmText: 'Delete permanently',
      tone: 'danger',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const { data } = await api.post('/audit/delete', { ids });
      if (data.deleted) toast.success(`Deleted ${entries(data.deleted)}.`);
      else toast.info('Nothing was deleted — those entries were already gone.');
      // Off the screen at once; the quiet reload then tops the page back up.
      const gone = new Set(ids);
      setItems((list) => list.filter((it) => !gone.has(it._id)));
      setSelected(new Set());
      load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete those entries');
    } finally {
      setDeleting(false);
    }
  };

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
          params.entity && `Module: ${params.entity}`,
          params.q && `Search: “${params.q}”`,
          params.from && `From ${day(params.from)}`,
          params.to && `To ${day(params.to)}`,
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
      load({ quiet: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not delete the entries');
    } finally {
      setDeleting(false);
    }
  };

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Audit Log" subtitle="Every status change across the portal · who changed what, and when" />
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">
          This tool isn&apos;t available for your account.
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Audit Log" subtitle="Every status change across the portal · who changed what, and when">
        {selected.size > 0 && (
          <button type="button" onClick={deleteSelected} disabled={deleting}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm disabled:opacity-50">
            Delete selected ({selected.size})
          </button>
        )}
        <button type="button" onClick={deleteMatching} disabled={deleting || loading || items.length === 0}
          className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
          title={filtersActive
            ? 'Permanently delete every entry these filters match — not only this page'
            : 'Permanently delete every entry in the audit log'}>
          {filtersActive ? 'Delete all matching' : 'Delete entire log'}
        </button>
      </PageHeader>

      <div className="bg-white shadow rounded-lg p-3 mb-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">Module</label>
          <SearchableSelect value={filters.entity} onChange={set('entity')} className="block w-full border rounded-lg px-3 py-2 text-sm">
            <option value="">All modules</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </SearchableSelect>
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">Search (record or person)</label>
          <input value={filters.q} onChange={set('q')} placeholder="name, status…" className="block w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">From</label>
          <input type="date" value={filters.from} onChange={set('from')} className="block w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">To</label>
          <input type="date" value={filters.to} onChange={set('to')} className="block w-full border rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 w-10">
              <input type="checkbox" aria-label="Select every entry on this page"
                checked={allSelected} onChange={toggleAll} disabled={loading || items.length === 0}
                // Part of the page ticked shows as a dash, not as an empty box.
                ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }} />
            </th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">When</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Changed by</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Module</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Record</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Change</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No matching changes recorded</td></tr>
            ) : items.map((it) => (
              <tr key={it._id} className={selected.has(it._id) ? 'bg-red-50/40' : undefined}>
                <td className="px-4 py-3">
                  <input type="checkbox" checked={selected.has(it._id)} onChange={() => toggle(it._id)}
                    aria-label={`Select the ${it.entity} change of ${fmt(it.at)}`} />
                </td>
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmt(it.at)}</td>
                <td className="px-4 py-3">
                  <span className="text-gray-900">{it.byName || 'System'}</span>
                  {it.byRole && <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded ${ROLE_STYLES[it.byRole] || 'bg-gray-100 text-gray-700'}`}>{it.byRole}</span>}
                </td>
                <td className="px-4 py-3 text-gray-600">{it.entity}</td>
                <td className="px-4 py-3 text-gray-800">{it.entityLabel || <span className="text-gray-400 font-mono text-xs">{String(it.entityId || '').slice(-6)}</span>}</td>
                {/* A BLANK "from" IS A CREATION, NOT A TRANSITION. The plugin
                    logs an empty fromStatus when the record was born carrying
                    the status — a leave filed and auto-approved in one act, say.
                    Drawn as "- → Approved" that reads as somebody approving
                    something, which is the opposite of what happened and put a
                    junior employee's name next to an approval they never made.
                    So a creation says so in words. */}
                <td className="px-4 py-3">
                  <span className="text-xs text-gray-500">{it.field}:</span>{' '}
                  {it.fromStatus ? (
                    <>
                      <span className="text-gray-500 line-through">{it.fromStatus}</span>
                      <span className="mx-1 text-gray-400">→</span>
                      <span className="font-medium text-gray-900">{it.toStatus || '-'}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-gray-500">created as</span>{' '}
                      <span className="font-medium text-gray-900">{it.toStatus || '-'}</span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length >= 200 && <p className="text-xs text-gray-400 mt-2">Showing the latest 200 changes · narrow the filters to see more specific results.</p>}
    </div>
  );
}
