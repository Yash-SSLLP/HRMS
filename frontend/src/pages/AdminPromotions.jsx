/**
 * AdminPromotions — give an employee a new designation and/or department, and
 * read back every promotion given so far.
 *
 * Server: GET /promotions/options (people + lists), GET /promotions (history),
 * POST /promotions (apply now, notify + mail the employee with the letter),
 * GET /promotions/:id/letter.pdf (the promotion / transfer letter). Who may write:
 * SuperAdmin, CEO/MD in either mode, and holders of employees.manage — the same
 * rule as promotionController.canPromote. The God viewer reads only.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiArrowRight, FiAward, FiCalendar, FiFileText, FiPlus, FiSearch, FiShuffle, FiUsers, FiX,
} from 'react-icons/fi';
import api from '../api/client';
import { openProtectedPdf } from '../api/download';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import DesignationSelect from '../components/DesignationSelect';
import DepartmentSelect from '../components/DepartmentSelect';
import { confirmDialog } from '../components/dialogs';
import { PersonAvatar } from '../components/permissions/permUi';
import { hasPermission, isViewOnlyAccount, canAdministerEmployee } from '../config/permissions';
import '../styles/pages/promotions.css';

const PROMOTER_ROLES = ['SuperAdmin', 'CEO', 'MD'];

const canPromote = (user) => !!user && !isViewOnlyAccount(user)
  && (PROMOTER_ROLES.includes(user.role) || hasPermission(user, 'employees.manage'));

/** Today in India as YYYY-MM-DD, for the date input's default. */
const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const monthKey = (d) => new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dayLabel = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const longDate = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

// `newDepartment`: the department was typed in with ＋ Add, so the server may create it.
const EMPTY_FORM = { employee: '', designation: '', department: '', newDepartment: false, effectiveDate: '', remarks: '' };

export default function AdminPromotions() {
  const user = useAuthStore((s) => s.user);
  const writable = canPromote(user);

  const [items, setItems] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [hist, opts] = await Promise.all([
        api.get('/promotions'),
        api.get('/promotions/options'),
      ]);
      setItems(hist.data.items || []);
      setPeople(opts.data.employees || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load promotions');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // An HR may not touch a Manager's record without the manager-profile grant;
  // the executives sit above that grant (promotionController.createPromotion).
  const pickable = useMemo(() => people.filter((p) => PROMOTER_ROLES.includes(user?.role)
    || canAdministerEmployee(user, { _id: p.userId, role: p.role })), [people, user]);

  const chosen = people.find((p) => String(p._id) === String(form.employee)) || null;

  const kpis = useMemo(() => {
    const now = new Date();
    const thisMonth = monthKey(now);
    const year = now.getFullYear();
    const promoted = items.filter((r) => r.newDesignation !== r.previousDesignation);
    return [
      { key: 'month', label: 'This month', value: items.filter((r) => monthKey(r.effectiveDate) === thisMonth).length, icon: FiCalendar, hue: 262 },
      { key: 'year', label: `In ${year}`, value: items.filter((r) => new Date(r.effectiveDate).getFullYear() === year).length, icon: FiAward, hue: 152 },
      { key: 'promoted', label: 'Promotions', value: promoted.length, icon: FiUsers, hue: 32 },
      { key: 'moves', label: 'Department moves', value: items.filter((r) => r.newDepartment !== r.previousDepartment).length, icon: FiShuffle, hue: 205 },
    ];
  }, [items]);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((r) => [r.name, r.employeeCode, r.newDesignation, r.previousDesignation, r.newDepartment, r.previousDepartment]
      .some((v) => String(v || '').toLowerCase().includes(term)));
  }, [items, q]);

  // Grouped by the month the promotion counts from, newest first.
  const groups = useMemo(() => {
    const sorted = [...shown].sort((a, b) => new Date(b.effectiveDate) - new Date(a.effectiveDate)
      || new Date(b.createdAt) - new Date(a.createdAt));
    const out = [];
    for (const r of sorted) {
      const key = monthKey(r.effectiveDate);
      if (!out.length || out[out.length - 1].key !== key) out.push({ key, rows: [] });
      out[out.length - 1].rows.push(r);
    }
    return out;
  }, [shown]);

  const openForm = (employeeId = '') => {
    const p = people.find((x) => String(x._id) === String(employeeId));
    setForm({ ...EMPTY_FORM, employee: employeeId, department: p?.department || '', effectiveDate: todayIST() });
    setFormError('');
    setOpen(true);
  };

  const pickEmployee = (id) => {
    const p = people.find((x) => String(x._id) === String(id));
    setForm((f) => ({ ...f, employee: id, designation: '', department: p?.department || '', newDepartment: false }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setFormError('');
    if (!chosen) { setFormError('Pick an employee.'); return; }
    if (!form.designation) { setFormError('Pick the new designation.'); return; }
    if (form.designation === chosen.designation && (form.department || chosen.department) === chosen.department) {
      setFormError('Nothing has changed — pick a new designation or department.');
      return;
    }
    const promoted = form.designation !== chosen.designation;
    const ok = await confirmDialog({
      title: promoted ? 'Give promotion?' : 'Change department?',
      message: promoted
        ? `${chosen.name} → ${form.designation}. They will get a notification and an email.`
        : `${chosen.name} → ${form.department}. They will get a notification and an email.`,
      confirmText: promoted ? 'Promote' : 'Change',
    });
    if (!ok) return;
    setSaving(true);
    try {
      await api.post('/promotions', {
        employee: form.employee,
        designation: form.designation,
        department: form.department || undefined,
        newDepartment: form.newDepartment || undefined,
        effectiveDate: form.effectiveDate || undefined,
        remarks: form.remarks.trim() || undefined,
      });
      toast.success(promoted ? `${chosen.name} promoted to ${form.designation}` : `${chosen.name} moved to ${form.department}`);
      setOpen(false);
      await load();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Could not save the promotion');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Promotions">
        {writable && (
          <button type="button" onClick={() => openForm()} className="trn-btn is-primary accent-bg text-white">
            <FiPlus size={15} /> Give promotion
          </button>
        )}
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="trn-kpis pro-kpis">
        {kpis.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.key} className="trn-kpi" style={{ '--kpi-hue': k.hue }}>
              <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
              <span className="min-w-0">
                <span className="trn-kpi-value block">{loading ? '—' : k.value}</span>
                <span className="trn-kpi-label block">{k.label}</span>
              </span>
            </div>
          );
        })}
      </div>

      <div className="pb-toolbar">
        <span className="pro-count">{loading ? '' : `${shown.length} of ${items.length}`}</span>
        <div className="pb-toolbar-end">
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or designation" aria-label="Search promotions" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="opacity-50 hover:opacity-100">
                <FiX size={14} />
              </button>
            )}
          </label>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiAward size={24} /></span>
            <p className="text-sm font-semibold">{items.length ? 'No promotions match' : 'No promotions yet'}</p>
          </div>
        </div>
      ) : (
        <div className="pro-groups">
          {groups.map((g) => (
            <section key={g.key} className="pro-group">
              <h3 className="pro-group-head">{g.key} <span className="pro-group-count">{g.rows.length}</span></h3>
              <div className="pro-list">
                {g.rows.map((r) => {
                  const promoted = r.newDesignation !== r.previousDesignation;
                  const moved = r.newDepartment !== r.previousDepartment;
                  return (
                    <article key={r._id} className="pro-row">
                      <PersonAvatar user={{ _id: r.userId, photo: r.photo, firstName: r.name }} />
                      <div className="pro-who">
                        <div className="pro-name">{r.name}</div>
                        <div className="pro-code">{r.employeeCode}</div>
                      </div>
                      <div className="pro-change">
                        {promoted && (
                          <div className="pro-line">
                            <span className="pro-old">{r.previousDesignation || '—'}</span>
                            <FiArrowRight size={14} className="pro-arrow" aria-label="to" />
                            <span className="pro-new">{r.newDesignation}</span>
                          </div>
                        )}
                        {moved ? (
                          <div className="pro-line is-dept">
                            <span className="pro-old">{r.previousDepartment || '—'}</span>
                            <FiArrowRight size={13} className="pro-arrow" aria-label="to" />
                            <span className="pro-new">{r.newDepartment}</span>
                          </div>
                        ) : (
                          <div className="pro-line is-dept"><span>{r.newDepartment}</span></div>
                        )}
                        {r.remarks && <div className="pro-remarks" title={r.remarks}>{r.remarks}</div>}
                      </div>
                      <div className="pro-meta">
                        <span className={`pro-tag${promoted ? ' is-promo' : ''}`}>{promoted ? 'Promotion' : 'Dept move'}</span>
                        <span className="pro-date" title={`Effective ${longDate(r.effectiveDate)}`}>{dayLabel(r.effectiveDate)}</span>
                        {r.promotedByName && <span className="pro-by">by {r.promotedByName}</span>}
                        <button type="button" className="pro-letter"
                          onClick={() => openProtectedPdf(`/promotions/${r._id}/letter.pdf`, 'Could not open the letter')
                            .catch((err) => toast.error(err.message))}
                          title={promoted ? 'Promotion letter (PDF)' : 'Transfer letter (PDF)'}>
                          <FiFileText size={13} /> Letter
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="card-title">Give promotion</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={submit} className="space-y-3.5">
              <label className="block">
                <span className="prm-label">Employee *</span>
                <SearchableSelect value={form.employee} onChange={(e) => pickEmployee(e.target.value)}
                  className="prm-input">
                  <option value="">Select…</option>
                  {pickable.map((p) => (
                    <option key={p._id} value={p._id}>{p.name}{p.employeeCode ? ` (${p.employeeCode})` : ''}</option>
                  ))}
                </SearchableSelect>
              </label>

              {chosen && (
                <div className="pro-current">
                  <PersonAvatar user={{ _id: chosen.userId, photo: chosen.photo, firstName: chosen.name }} size="sm" />
                  <div className="min-w-0">
                    <div className="pro-current-label">Now</div>
                    <div className="pro-current-value">{[chosen.designation || 'No designation', chosen.department || 'No department'].join(' · ')}</div>
                  </div>
                </div>
              )}

              <div className="grid gap-3.5 sm:grid-cols-2">
                <label className="block">
                  <span className="prm-label">New designation *</span>
                  <DesignationSelect value={form.designation} onChange={(v) => setForm((f) => ({ ...f, designation: v }))}
                    createLocally className="prm-input" />
                </label>
                <label className="block">
                  <span className="prm-label">Department</span>
                  <DepartmentSelect value={form.department}
                    onChange={(v) => setForm((f) => ({ ...f, department: v, newDepartment: false }))}
                    onCreateNew={() => setForm((f) => ({ ...f, newDepartment: true }))}
                    createLocally className="prm-input" />
                </label>
              </div>

              <label className="block">
                <span className="prm-label">Effective from *</span>
                <input type="date" required value={form.effectiveDate}
                  onChange={(e) => setForm((f) => ({ ...f, effectiveDate: e.target.value }))}
                  className="prm-input" />
              </label>

              <label className="block">
                <span className="prm-label">Remarks</span>
                <textarea rows={2} maxLength={500} value={form.remarks}
                  onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))}
                  className="prm-input" />
              </label>

              {formError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{formError}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setOpen(false)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={saving} className="trn-btn is-primary accent-bg text-white">
                  {saving ? 'Saving…' : 'Save promotion'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
