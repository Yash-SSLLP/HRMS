/**
 * ExitClearanceInbox — the "no-dues" queue for a department manager. When HR
 * assigns you a clearance section on an exiting employee (IT / HR / Accounts /
 * Sales), it appears here during their notice period. You tick each company
 * asset/due as it's handed back, add any remarks for HR, and Submit; once every
 * item is ticked the section is cleared. Scoped server-side to sections
 * assigned to the current user.
 *
 * HISTORY (2026-09-25): every leaver whose checklist had a section of mine,
 * newest last working day first — with what I submitted, when and my remarks.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import ApprovalsEmpty from './ApprovalsEmpty';
import ApprovalsTabs, { useShowMore, OUTCOME_COLORS, HistoryEmpty } from './ApprovalsTabs';
import { useAuthStore } from '../store/authStore';
import { formatDateTime12 } from '../utils/time';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const empName = (r) => `${r.employee?.user?.firstName || ''} ${r.employee?.user?.lastName || ''}`.trim() || 'Employee';
const draftKey = (exitId, sectionKey) => `${exitId}:${sectionKey}`;

// What the server holds for a section, in the shape the form edits.
const savedState = (s) => ({ done: s.items.map((it) => !!it.done), remarks: s.remarks || '' });

export default function ExitClearanceInbox({ onCount }) {
  const me = useAuthStore((s) => s.user);
  const myId = me?._id || me?.id;
  const [rows, setRows] = useState([]);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState('pending'); // 'pending' | 'history'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  // Ticks and remarks are a DRAFT until Submit. Ticking used to save on every
  // click, so a manager half-way through a checklist had already told the
  // server — and the moment the last box went on, the section cleared with no
  // chance to say "the laptop came back with a cracked screen". Keyed by
  // exit + section; a section with no entry is showing exactly what is saved.
  const [drafts, setDrafts] = useState({});

  const loadHistory = () => api.get('/approvals/clearances?scope=history')
    .then(({ data }) => setHistory(data.requests || []));

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [{ data }] = await Promise.all([
        api.get('/approvals/clearances?scope=pending'),
        // History failing must not take the queue down with it.
        loadHistory().catch(() => {}),
      ]);
      setRows(data.requests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load no-dues clearances');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Report the pending count to the page shell (ApprovalsBoard) so the summary
  // rail and this section's count pill can show it. Optional — the inbox still
  // works standalone. Held back until the first load finishes, so "0" always
  // means "all clear" and never "not fetched yet".
  useEffect(() => { if (!loading) onCount?.(rows.length); }, [loading, rows, onCount]);

  // History minus the leavers still waiting on me above, newest leaver first.
  const pendingIds = new Set(rows.map((r) => r._id));
  const others = history
    .filter((r) => !pendingIds.has(r._id))
    .sort((a, b) => new Date(b.lastWorkingDay || 0) - new Date(a.lastWorkingDay || 0));
  const { shown, more } = useShowMore(others, history);

  // Only the sections assigned to me on a given exit.
  const mySections = (r) =>
    (r.clearanceSections || []).filter((s) => String(s.assignedTo?._id || s.assignedTo || '') === String(myId || ''));

  const draftOf = (exit, s) => drafts[draftKey(exit._id, s.key)] || savedState(s);

  const setDraft = (exit, s, patch) => setDrafts((d) => {
    const k = draftKey(exit._id, s.key);
    return { ...d, [k]: { ...(d[k] || savedState(s)), ...patch } };
  });

  const toggleItem = (exit, s, idx, done) => {
    const cur = draftOf(exit, s).done;
    setDraft(exit, s, { done: cur.map((v, i) => (i === idx ? done : v)) });
  };

  const submit = async (exit, s) => {
    const k = draftKey(exit._id, s.key);
    const draft = draftOf(exit, s);
    const items = s.items.map((it, i) => ({ done: !!draft.done[i], note: it.note }));
    setBusy(k);
    setError('');
    try {
      const { data } = await api.patch(`/approvals/clearances/${exit._id}/${s.key}`, {
        items,
        remarks: draft.remarks,
        submit: true,
      });
      const sections = data.request.clearanceSections || [];
      const saved = sections.find((x) => x.key === s.key);
      const stillMine = sections.some((x) => String(x.assignedTo?._id || x.assignedTo || '') === String(myId || '') && !x.completed);
      setDrafts((d) => { const n = { ...d }; delete n[k]; return n; });
      // Nothing left for me on this exit → it is no longer waiting on me, so it
      // leaves the queue (and the tab's count drops) rather than sitting here
      // marked Cleared until the next reload.
      setRows((prev) => (stillMine
        ? prev.map((r) => (r._id === exit._id ? { ...r, clearanceSections: sections } : r))
        : prev.filter((r) => r._id !== exit._id)));
      loadHistory().catch(() => {});
      if (saved?.completed) {
        toast.success(`${s.title} no-dues cleared for ${empName(exit)} — HR has been told.`);
      } else {
        const left = (saved?.items || []).filter((it) => !it.done).length;
        toast.info(`Submitted. ${left} item${left === 1 ? '' : 's'} still pending — it stays in your queue until ticked.`);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit the no-dues checklist');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <div className="text-gray-500">Loading…</div>;

  return (
    <div>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <ApprovalsTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'pending', label: 'To clear', count: rows.length },
          { key: 'history', label: 'History', count: others.length },
        ]}
      />

      {/* No inner card — ApprovalsBoard's section card is the surface. */}
      {tab === 'pending' && <div>
        {rows.length === 0 ? (
          <ApprovalsEmpty message="No no-dues clearances are waiting on you." hint="A leaver's checklist appears here while your department still has to sign off." />
        ) : (
          <ul className="divide-y divide-gray-100">
            {rows.map((r) => (
              <li key={r._id} className="py-4">
                <div className="text-sm font-medium text-gray-900">
                  {empName(r)}
                  <span className="ml-2 text-xs font-mono text-gray-400">{r.employee?.employeeCode}</span>
                </div>
                <div className="text-xs text-gray-500 mb-2">
                  {r.employee?.designation || ''}{r.employee?.department ? ` · ${r.employee.department}` : ''} · last working day {fmtDate(r.lastWorkingDay)}
                </div>
                {/* What the leaver still holds, off the asset register. The
                    checklist below only says "Laptop"; this says WHICH laptop,
                    so the MacBook issued to them comes back and not the spare
                    Asus from the cupboard. Read-only — ticking a checklist item
                    does not return the holding; HR books the hand-back on the
                    exit (or the Assets page), and that is what drops a line
                    from here on the next load. */}
                {r.heldAssets?.length > 0 && (
                  <div className="mb-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                    <div className="text-xs font-medium text-amber-800">
                      Company assets with them ({r.heldAssets.length})
                    </div>
                    <ul className="mt-1 space-y-1">
                      {r.heldAssets.map((a) => (
                        <li key={a._id} className="text-sm text-gray-800 break-words">
                          <span className="font-medium">{a.name || 'Asset'}</span>
                          {a.details ? <span> — {a.details}</span> : null}
                          {a.serialNumber ? <span className="text-xs text-gray-500"> · SN {a.serialNumber}</span> : null}
                          {/* The unit's own sticker, monospace like every other
                              tag in the portal (O vs 0, I vs 1). */}
                          {a.unitTag ? <span className="text-xs text-gray-500"> · <span className="font-mono">{a.unitTag}</span></span> : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {mySections(r).map((s) => {
                  const k = draftKey(r._id, s.key);
                  const draft = draftOf(r, s);
                  const saved = savedState(s);
                  const dirty = draft.remarks.trim() !== saved.remarks.trim()
                    || draft.done.some((v, i) => v !== saved.done[i]);
                  const ticked = draft.done.filter(Boolean).length;
                  const total = s.items.length;
                  const submitting = busy === k;
                  return (
                    <div key={s.key} className="mt-2 bg-gray-50 border rounded-lg p-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-sm font-medium text-gray-800">{s.title}</div>
                        {/* Both chips carry the border — Pending's is transparent — so a
                            status change only repaints it. Give Pending no border and
                            the row grows 2px, twitching the checklist under the cursor. */}
                        {s.completed
                          ? <span className="text-xs text-green-700 bg-green-50 border border-green-200 rounded px-1.5 py-0.5">Cleared</span>
                          : <span className="text-xs text-gray-500 bg-gray-100 border border-transparent rounded px-1.5 py-0.5">Pending</span>}
                      </div>
                      <p className="text-xs text-gray-500 mb-2">Tick each item once it has been handed back to the company, then submit.</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                        {s.items.map((it, idx) => (
                          <label key={idx} className="flex items-center gap-2 text-sm">
                            <input type="checkbox" checked={!!draft.done[idx]}
                              disabled={submitting}
                              onChange={(e) => toggleItem(r, s, idx, e.target.checked)} />
                            {it.label}
                          </label>
                        ))}
                      </div>

                      <label className="block mt-3">
                        <span className="text-xs font-medium text-gray-600">Remarks</span>
                        <textarea
                          rows={2}
                          value={draft.remarks}
                          disabled={submitting}
                          maxLength={2000}
                          onChange={(e) => setDraft(r, s, { remarks: e.target.value })}
                          placeholder="Anything HR should know — e.g. laptop returned with a damaged charger, SIM still with the employee"
                          className="mt-1 w-full border rounded-lg px-3 py-2 text-sm"
                        />
                      </label>

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-gray-500 min-w-0 grow basis-64">
                          {ticked < total
                            ? `${ticked} of ${total} ticked · unticked items keep this section pending`
                            : 'All items ticked · submitting clears this section'}
                          {s.submittedAt && (
                            <span className="block text-gray-400">
                              Last submitted {formatDateTime12(s.submittedAt)}{s.submittedByName ? ` by ${s.submittedByName}` : ''}
                              {dirty ? ' · unsaved changes' : ''}
                            </span>
                          )}
                          {!s.submittedAt && dirty && <span className="block text-amber-700">Not saved until you submit</span>}
                        </div>
                        <button
                          type="button"
                          onClick={() => submit(r, s)}
                          disabled={submitting || (!dirty && !!s.submittedAt)}
                          className="ml-auto px-4 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {submitting ? 'Submitting…' : 'Submit'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </li>
            ))}
          </ul>
        )}
      </div>}

      {tab === 'history' && (others.length === 0 ? (
        <HistoryEmpty>No other no-dues checklists reference you.</HistoryEmpty>
      ) : (
        <>
          <ul className="divide-y divide-gray-100">
            {shown.map((r) => (
              <li key={r._id} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <div className="min-w-0 sm:flex-1">
                  <div className="text-sm text-gray-800">
                    {empName(r)}
                    <span className="ml-2 text-xs font-mono text-gray-400">{r.employee?.employeeCode}</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    {r.employee?.designation || ''}{r.employee?.department ? ` · ${r.employee.department}` : ''} · last working day {fmtDate(r.lastWorkingDay)}
                  </div>
                  {/* The Super Admin's history is every leaver, most with no
                      section of theirs — show the whole checklist then. */}
                  {(mySections(r).length ? mySections(r) : (r.clearanceSections || [])).map((s) => {
                    const ticked = (s.items || []).filter((it) => it.done).length;
                    return (
                      <div key={s.key} className="mt-1 text-[11px] text-gray-600 break-words">
                        <span className="font-medium text-gray-700">{s.title}</span>
                        {' · '}
                        {s.completed
                          ? <span className="text-green-700">Cleared</span>
                          : <span className="text-amber-700">{ticked} of {(s.items || []).length} ticked</span>}
                        {s.submittedAt ? ` · submitted ${formatDateTime12(s.submittedAt)}${s.submittedByName ? ` by ${s.submittedByName}` : ''}` : ' · never submitted'}
                        {s.remarks ? ` — “${s.remarks}”` : ''}
                      </div>
                    );
                  })}
                </div>
                <span className={`inline-block self-start px-2 py-0.5 text-xs rounded-lg shrink-0 ${OUTCOME_COLORS[r.status] || ''}`}>
                  {r.status === 'InClearance' ? 'In notice' : r.status}
                </span>
              </li>
            ))}
          </ul>
          {more}
        </>
      ))}
    </div>
  );
}
