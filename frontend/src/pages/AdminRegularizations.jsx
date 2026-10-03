/**
 * AdminRegularizations — the attendance-correction review queue (admin portal).
 *
 * Lists GET /regularizations and decides via PATCH /regularizations/:id/status
 * (an approval applies the corrected punch). CEO/MD see the oversight columns
 * (who changed what); their only action here is deciding an HR's OWN request,
 * which HR may not decide for themselves.
 *
 * HR IS THE FINAL RUNG of every ladder, so a Pending row is one of two things
 * and the row says which: "Your approval" (it has cleared its named approvers,
 * or never had any) or "With <name>" (still climbing). Deciding the second is
 * an OVERRIDE — it voids the remaining steps — so it asks first.
 *
 * Who signs off each employee's corrections BEFORE they reach HR is configured
 * on the Permissions page (components/permissions/RegularizationApprovalSetup.jsx).
 *
 * 2026-10-03 redesign (user: "redesign this too"): KPI cards that double as the
 * filter, a toolbar (views + search), and one card per request grouped by the
 * day it was filed — the punch change drawn as before → after time blocks.
 * The list is loaded once (the endpoint is unpaged) and filtered here, so the
 * counts on the cards are always the whole queue. Styling: `.rg-*` in index.css.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  FiClock, FiCheckCircle, FiXCircle, FiInbox, FiUsers, FiSearch, FiX, FiRefreshCw, FiArrowRight, FiLogIn, FiLogOut,
} from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { formatTime12 as fmt12, toYMD } from '../utils/time';
import { isViewOnly } from '../config/permissions';
import { PersonAvatar } from '../components/permissions/permUi';
import { ProofLinks } from '../components/RegularizationAttachments';

const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
const ROLE_WORDS = { SuperAdmin: 'Super Admin', HRManager: 'HR Manager', CEO: 'CEO', MD: 'MD' };

/** "Filed today" / "Filed yesterday" / "Filed 02 Oct 2026" — the day heading. */
const filedHeading = (ymd) => {
  const today = toYMD(new Date());
  const yesterday = toYMD(new Date(Date.now() - 86400000));
  if (ymd === today) return { label: 'Today', rel: true };
  if (ymd === yesterday) return { label: 'Yesterday', rel: true };
  return { label: new Date(`${ymd}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }), rel: false };
};

/** One punch, before → after. The after value is the one that will stand. */
function PunchChange({ icon: Icon, label, from, to }) {
  const changed = from !== to;
  return (
    <div className={`rg-punch${changed ? ' is-changed' : ''}`}>
      <span className="rg-punch-label"><Icon size={11} /> {label}</span>
      <span className="rg-punch-from">{from}</span>
      <FiArrowRight size={11} className="rg-punch-arrow" />
      <span className="rg-punch-to">{to}</span>
    </div>
  );
}

export default function AdminRegularizations() {
  const me = useAuthStore((s) => s.user);
  const myId = me?._id || me?.id;
  // A view-only CEO/MD is read-only everywhere except one row type: an HR's own
  // regularization, which HR must not decide for themselves. An exec a
  // SuperAdmin has put in edit mode decides any row, like HR.
  const isExec = isViewOnly(me);

  // Who may decide this request, mirroring regularizationController.js. Returns
  // null when the viewer may act, otherwise the reason they may not.
  const blockedReason = (r) => {
    const requesterId = r.employee?._id || r.employee;
    const requesterIsHr = r.employee?.role === 'HRManager';
    if (myId && String(requesterId) === String(myId)) return 'Your own request';
    if (requesterIsHr && !['SuperAdmin', 'CEO', 'MD'].includes(me?.role)) return 'Needs CEO / MD / Super Admin';
    if (isExec && !requesterIsHr) return 'HR to decide';
    return null;
  };

  const [items, setItems] = useState([]);
  // Only the FIRST load blanks the queue; later fetches keep the rows and spin
  // the refresh icon, so a decision never throws the page around.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState('all');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = async () => {
    setRefreshing(true);
    setError('');
    try {
      const { data } = await api.get('/regularizations');
      setItems(data.items || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { load(); }, []);

  const review = async (r, status) => {
    setError('');
    // Deciding a request that has not reached you yet SKIPS its named approver —
    // the valve for an approver who is away, but not the normal act — so it asks.
    if (r.status === 'Pending' && r.awaitingHr === false) {
      const ok = await confirmDialog({
        title: `${status === 'Approved' ? 'Approve' : 'Reject'} before their approver?`,
        message: `This is still with ${r.waitingOn || 'their approver'}. Deciding it now skips that step — they will be told it no longer needs them.`,
        confirmText: status === 'Approved' ? 'Approve anyway' : 'Reject anyway',
        tone: 'warning',
      });
      if (!ok) return;
    }
    let reviewNote = '';
    if (status === 'Rejected') {
      reviewNote = (await promptDialog({ message: 'Reason for rejection (optional):' })) || '';
    }
    setBusyId(r._id);
    try {
      await api.patch(`/regularizations/${r._id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    } finally {
      setBusyId('');
    }
  };

  // Which view a request belongs to. "Yours" = pending, at HR's rung, and
  // something this viewer may decide; "others" = pending on somebody else (still
  // climbing its ladder, or one this viewer may not decide).
  const viewOf = (r) => {
    if (r.status === 'Approved') return 'approved';
    if (r.status === 'Rejected') return 'rejected';
    if (r.awaitingHr === false) return 'others';
    return blockedReason(r) ? 'others' : 'yours';
  };
  const counts = useMemo(() => {
    const c = { all: items.length, yours: 0, others: 0, approved: 0, rejected: 0 };
    items.forEach((r) => { c[viewOf(r)] += 1; });
    return c;
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((r) => {
      const v = viewOf(r);
      if (view === 'pending' && !['yours', 'others'].includes(v)) return false;
      if (!['all', 'pending'].includes(view) && v !== view) return false;
      if (!needle) return true;
      return [fullName(r.employee), r.employee?.email, r.type, r.reason].join(' ').toLowerCase().includes(needle);
    });
  }, [items, view, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Grouped by the day each request was FILED (the list is newest-filed first).
  const groups = useMemo(() => {
    const m = new Map();
    shown.forEach((r) => {
      const k = toYMD(new Date(r.createdAt || r.date));
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return [...m.entries()];
  }, [shown]);

  const KPIS = [
    { key: 'yours', label: 'Waiting on you', value: counts.yours, icon: FiInbox, hue: '#d97706' },
    { key: 'others', label: 'With others', value: counts.others, icon: FiUsers, hue: '#6366f1' },
    { key: 'approved', label: 'Approved', value: counts.approved, icon: FiCheckCircle, hue: '#16a34a' },
    { key: 'rejected', label: 'Rejected', value: counts.rejected, icon: FiXCircle, hue: '#dc2626' },
  ];
  const VIEWS = [
    { key: 'all', label: 'All', n: counts.all },
    { key: 'pending', label: 'Pending', n: counts.yours + counts.others },
    { key: 'approved', label: 'Approved', n: counts.approved },
    { key: 'rejected', label: 'Rejected', n: counts.rejected },
  ];
  const pickKpi = (key) => setView((v) => (v === key ? 'all' : key));

  return (
    <div>
      <PageHeader title="Attendance Regularization">
        <button type="button" onClick={load} disabled={refreshing} className="trn-btn" title="Refresh">
          <FiRefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
        </button>
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-xl">{error}</div>}

      <div className="rg-kpis">
        {KPIS.map((k) => {
          const Icon = k.icon;
          const on = view === k.key;
          return (
            <button key={k.key} type="button" onClick={() => pickKpi(k.key)} aria-pressed={on}
              className={`trn-kpi pb-kpi${on ? ' is-on' : ''}`} style={{ '--kpi-hue': k.hue }}>
              <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
              <span className="min-w-0">
                <span className="trn-kpi-value block">{loading ? '—' : k.value}</span>
                <span className="trn-kpi-label block">{k.label}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="pb-toolbar mt-4">
        <div className="trn-seg" role="tablist" aria-label="Show">
          {VIEWS.map((v) => (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} onClick={() => setView(v.key)}
              className={`trn-seg-btn${view === v.key ? ' is-on' : ''}`}>
              {v.label} <span className="trn-seg-count">{v.n}</span>
            </button>
          ))}
        </div>
        <div className="pb-toolbar-end">
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, type or reason" aria-label="Search requests" />
            {q && <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="opacity-50 hover:opacity-100"><FiX size={14} /></button>}
          </label>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2.5">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>
      ) : groups.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiClock size={24} /></span>
            <p className="text-sm font-semibold">{q || view !== 'all' ? 'No requests match' : 'No regularization requests'}</p>
          </div>
        </div>
      ) : groups.map(([ymd, list]) => {
        const h = filedHeading(ymd);
        return (
          <section key={ymd} className="rst-day">
            <div className="rst-day-head">
              <span className="rst-day-title">{h.rel ? `Filed ${h.label.toLowerCase()}` : `Filed ${h.label}`}</span>
              <span className="rst-day-count">{list.length}</span>
            </div>
            <div className="rg-list">
              {list.map((r) => {
                const toIn = fmt12(r.appliedCheckIn) || fmt12(r.requestedCheckIn) || '—';
                const toOut = fmt12(r.appliedCheckOut) || fmt12(r.requestedCheckOut) || '—';
                const fromIn = fmt12(r.previousCheckIn) || '—';
                const fromOut = fmt12(r.previousCheckOut) || '—';
                const blocked = blockedReason(r);
                return (
                  <article key={r._id} className={`rg-card is-${r.status.toLowerCase()}${busyId === r._id ? ' is-busy' : ''}`}>
                    <div className="rg-who">
                      <PersonAvatar user={r.employee} />
                      <div className="min-w-0">
                        <div className="rg-name">
                          {r.employee ? fullName(r.employee) : '-'}
                          {r.employee?.role === 'HRManager' && (
                            <span className="rg-hr" title="HR's own request — only the CEO, MD or a Super Admin can decide it">HR</span>
                          )}
                        </div>
                        <div className="rg-sub">{r.employee?.email}</div>
                      </div>
                    </div>

                    <div className="rg-what">
                      <div className="rg-what-top">
                        <span className="rg-type">{r.type}</span>
                        <span className="rg-for">for {fmtDay(r.date)}</span>
                        {r.previousStatus && <span className="rg-was">was {r.previousStatus}</span>}
                      </div>
                      <div className="rg-punches">
                        <PunchChange icon={FiLogIn} label="In" from={fromIn} to={toIn} />
                        <PunchChange icon={FiLogOut} label="Out" from={fromOut} to={toOut} />
                      </div>
                    </div>

                    <div className="rg-why">
                      <div className="rg-reason">{r.reason || '—'}</div>
                      {r.reviewNote && <div className="rg-note">{r.reviewNote}</div>}
                      <ProofLinks reg={r} />
                    </div>

                    <div className="rg-side">
                      <span className={`rg-status is-${r.status.toLowerCase()}`}>{r.status}</span>
                      {r.status === 'Pending' ? (
                        r.awaitingHr === false ? (
                          <span className="rg-meta is-amber" title="Deciding this now overrides their approval step">With {r.waitingOn || 'their approver'}</span>
                        ) : (
                          <span className="rg-meta">{blocked || 'Your approval'}</span>
                        )
                      ) : r.reviewedBy ? (
                        <span className="rg-meta">
                          {fullName(r.reviewedBy)} · {ROLE_WORDS[r.reviewedBy.role] || r.reviewedBy.role}
                          {r.reviewedAt ? ` · ${fmtDay(r.reviewedAt)}` : ''}
                        </span>
                      ) : null}
                      {r.status === 'Pending' && !blocked && (
                        <div className="rg-actions">
                          <button type="button" onClick={() => review(r, 'Approved')} disabled={busyId === r._id} className="trn-btn rg-approve">
                            <FiCheckCircle size={14} /> Approve
                          </button>
                          <button type="button" onClick={() => review(r, 'Rejected')} disabled={busyId === r._id} className="trn-btn is-danger">
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
