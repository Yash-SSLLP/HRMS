/**
 * AdminPayrollRun — "Hikes" (admin portal). Sets an employee's salary basis:
 * their salary structure and annual CTC (PUT /employees/:id), CTC increments
 * (POST /payroll/employees/:id/hike), and the revision history — alongside the
 * month's attendance roll-up (GET /attendance/month-summary,
 * GET /payroll/run-employee) for context on what a hike is being given against.
 *
 * Generating, holding and approving payslips lives on the Payroll page; this
 * screen no longer carries the day calendar or the computed-salary panel.
 *
 * CEO/MD APPROVAL (user decision 2026-09-24). Once an employee's salary is
 * saved, an HR's change to it — Save with a different structure or CTC, or a
 * revision — is sent to a CEO, MD or Super Admin instead of being applied, and
 * reaches payroll only when they approve it (backend/services/salaryChanges.js).
 * Filling in a salary that is not set up yet still saves at once. The approvers'
 * own changes apply directly, and they approve HR's from the list at the top of
 * this page or from Approvals → Salary changes.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiArrowDownRight, FiArrowRight, FiArrowUpRight, FiCalendar, FiCheck, FiClock, FiFileText,
  FiLayers, FiRefreshCw, FiShield, FiSliders, FiTrendingUp, FiX,
} from 'react-icons/fi';
import api from '../api/client';
import { openProtectedPdf } from '../api/download';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { canAdministerEmployee, canApproveSalaryChanges, isReadOnlyExec } from '../config/permissions';
import SearchableSelect from '../components/SearchableSelect';
import { peopleOptions } from '../utils/peopleOptions';
import SalaryChangeInbox from '../components/SalaryChangeInbox';
import { promptDialog } from '../components/dialogs';
import { useNavCountsStore } from '../store/navCountsStore';
import { PersonAvatar } from '../components/permissions/permUi';
import '../styles/pages/hikes.css';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// A salary structure's components, in payslip order, for the monthly split.
const SPLIT_KEYS = [
  ['basicPct', 'Basic'], ['hraPct', 'HRA'], ['specialAllowancePct', 'Special'],
  ['conveyancePct', 'Conveyance'], ['medicalPct', 'Medical'], ['ltaPct', 'LTA'],
];

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

// Hikes — pick an employee and a month, set their salary structure + annual CTC,
// and give increments. The attendance roll-up beside it (paid/LOP days, leave,
// lateness) is context for the decision, not an editing surface.
export default function AdminPayrollRun() {
  const now = new Date();
  const currentUser = useAuthStore((s) => s.user);
  const [employees, setEmployees] = useState([]);
  const [structures, setStructures] = useState([]);
  const [employee, setEmployee] = useState('');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const [att, setAtt] = useState(null);   // month-summary payload
  const [run, setRun] = useState(null);   // run-employee payload
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState({ salaryStructure: '', annualCtc: '' });
  const [hike, setHike] = useState(null); // hike modal form, or null when closed
  const [showAllRevisions, setShowAllRevisions] = useState(false);
  // Bumped after anything that can add, decide or withdraw a salary change, so
  // both approval lists on the page reload with it.
  const [changesKey, setChangesKey] = useState(0);

  useEffect(() => {
    api.get('/employees?excludeExecutives=true').then(({ data }) => {
      const profiles = (data.profiles || []).filter((p) => p.user);
      setEmployees(profiles);
      setEmployee((e) => e || profiles[0]?._id || '');
    }).catch(() => {});
    api.get('/salary-structures').then(({ data }) => setStructures(data.structures || [])).catch(() => {});
  }, []);

  const load = async (emp = employee) => {
    if (!emp) return;
    if (emp !== run?.employee?._id) setShowAllRevisions(false);
    setLoading(true); setError('');
    try {
      const [aRes, rRes] = await Promise.all([
        api.get(`/attendance/month-summary?employee=${emp}&year=${year}&month=${month}`),
        api.get(`/payroll/run-employee?employee=${emp}&year=${year}&month=${month}`),
      ]);
      setAtt(aRes.data);
      setRun(rRes.data);
      setSetup({
        salaryStructure: rRes.data.employee?.salaryStructure?._id || '',
        // Prefill the current CTC so "Give hike" always starts from the effective
        // figure — fall back to the resolved CTC (from hike history) when the raw
        // annualCtc field hasn't been set yet.
        annualCtc: rRes.data.employee?.annualCtc || rRes.data.computed?.ctc || '',
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
      setAtt(null); setRun(null);
    } finally { setLoading(false); }
  };
  // First load once the employee list arrives; after that the OK button applies.
  useEffect(() => { if (employee && !att) load(employee); /* eslint-disable-next-line */ }, [employee]);

  // A new salary change is waiting (or one was just decided): refresh both
  // lists and the sidebar/Approvals counts, not only this employee's card.
  const changesMoved = () => {
    setChangesKey((k) => k + 1);
    useNavCountsStore.getState().refresh({ admin: true, force: true });
  };

  // ----- salary setup + hikes -----
  const saveSetup = async () => {
    // Changing a SAVED salary is, from an HR, a request — ask why, for the
    // approver. Cancelling the prompt cancels the save; an empty answer is fine.
    let reason;
    if (saveNeedsApproval) {
      reason = await promptDialog({
        title: 'Send for CEO/MD approval',
        message: 'This salary is already saved, so the change goes to a CEO, MD or Super Admin and reaches payroll only once they approve it. Why is it changing? (optional — the approver sees this)',
        placeholder: 'e.g. Corrected CTC from the offer letter',
        confirmText: 'Send for approval',
      });
      if (reason === null) return;
    }
    setBusy(true);
    try {
      const { status } = await api.put(`/payroll/employees/${employee}/salary-setup`, {
        salaryStructure: setup.salaryStructure || null,
        annualCtc: Number(setup.annualCtc) || 0,
        ...(reason ? { reason } : {}),
      });
      if (status === 202) {
        toast.info('Sent to the CEO/MD for approval — the salary stays as it is until they approve it.');
        changesMoved();
      } else {
        toast.success('Salary setup saved');
      }
      await load();
    } catch (err) { toast.error(err.response?.data?.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  // ----- salary hike / increment -----
  const openHike = () => setHike({
    // `direction` carries the sign so the amount field stays a plain positive
    // magnitude — typing "-5000" to cut pay is easy to do by accident and easy
    // to misread. Irrelevant in 'set' mode, where the value IS the new CTC.
    mode: 'percent', direction: 'increase', value: '',
    effectiveYear: year, effectiveMonth: month,
    newStructure: '', reason: '', // '' = keep current structure
  });

  /** The value actually sent: negative when this is a reduction. */
  const signedHikeValue = (h) => {
    const v = Number(h.value) || 0;
    return h.mode !== 'set' && h.direction === 'decrease' ? -v : v;
  };

  // Live preview of the resulting CTC from the current hike inputs.
  const hikePreviewCtc = (() => {
    if (!hike) return 0;
    const cur = Number(setup.annualCtc) || 0;
    const v = signedHikeValue(hike);
    if (hike.mode === 'percent') return Math.round(cur * (1 + v / 100));
    if (hike.mode === 'amount') return Math.round(cur + v);
    return Math.round(v); // set
  })();

  const submitHike = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { data } = await api.post(`/payroll/employees/${employee}/hike`, {
        mode: hike.mode,
        value: signedHikeValue(hike),
        newStructure: hike.newStructure || undefined,
        effectiveYear: Number(hike.effectiveYear),
        effectiveMonth: Number(hike.effectiveMonth),
        reason: hike.reason,
      });
      setHike(null);
      const cut = data.entry.newCtc < data.entry.previousCtc;
      if (data.pendingApproval) {
        // An HR's revision is a request: nothing changes until a CEO/MD agrees.
        toast.info(`${cut ? 'Reduction' : 'Hike'} to ${inr(data.entry.newCtc)} sent to the CEO/MD for approval — it reaches payroll only once approved.`);
        changesMoved();
      } else {
        toast.success(data.applied
          ? `${cut ? 'Reduction' : 'Hike'} applied · new CTC ${inr(data.entry.newCtc)}`
          : `${cut ? 'Reduction' : 'Hike'} scheduled from ${MONTHS[(data.entry.effectiveMonth || 1) - 1]} ${data.entry.effectiveYear}`);
      }
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not apply the hike');
    } finally { setBusy(false); }
  };

  const c = run?.computed;
  const slip = run?.payslip;
  // Nobody revises their own CTC, and a Manager's needs the manager-profile
  // grant. The server refuses either way; this greys the two buttons instead of
  // failing on click.
  const canRevise = canAdministerEmployee(currentUser, run?.employee?.user);
  // A read-only CEO/MD is greyed out for a different reason entirely — they are
  // read-only everywhere — and the own-salary/Manager wording blamed a grant
  // they were never missing.
  const NO_MANAGER_SALARY = isReadOnlyExec(currentUser)
    ? 'Your account is read-only here (a Super Admin can switch on edit access). You can still approve the salary changes HR sends you — in the list at the top of this page, or Approvals → Salary changes.'
    : "Not yours to set — you cannot revise your own salary, and a Manager's needs a Super Admin's permission.";

  // CEO/MD approval. `required`: this viewer's changes to a SAVED salary wait
  // for a CEO/MD/Super Admin. `pending`: a change for this employee already is.
  const approvalRequired = run?.salaryApproval?.required ?? !canApproveSalaryChanges(currentUser);
  const pendingChange = run?.salaryApproval?.pending || null;
  // One waiting change per salary — the server refuses a second one on top.
  const heldByPending = approvalRequired && !!pendingChange;
  const HELD = 'A change for this employee is already waiting for CEO/MD approval — withdraw it, or wait for the decision.';
  const savedStructure = String(run?.employee?.salaryStructure?._id || run?.employee?.salaryStructure || '');
  const savedCtc = Number(run?.employee?.annualCtc) || Number(c?.ctc) || 0;
  const salarySaved = !!savedStructure || savedCtc > 0;
  // Would THIS save replace something already saved, rather than fill a blank?
  // The same test the server makes (services/salaryChanges.classifySetup) — it
  // only decides the button's wording; the server decides what happens.
  const saveNeedsApproval = approvalRequired && (
    (setup.salaryStructure !== savedStructure && !!savedStructure)
    || ((Number(setup.annualCtc) || 0) !== savedCtc && savedCtc > 0));

  // The structure's percentages turned into this month's rupees — what the CTC
  // actually pays out as, per component. Display only; payroll computes its own.
  const structureObj = run?.employee?.salaryStructure && typeof run.employee.salaryStructure === 'object'
    ? run.employee.salaryStructure : null;
  const monthlySplit = structureObj?.components && savedCtc > 0
    ? SPLIT_KEYS
      .map(([key, label]) => ({ label, amount: Math.round((savedCtc * (Number(structureObj.components[key]) || 0)) / 100 / 12) }))
      .filter((r) => r.amount > 0)
    : [];
  const revisions = run?.employee?.ctcHistory ? [...run.employee.ctcHistory].reverse() : [];
  const shownRevisions = showAllRevisions ? revisions : revisions.slice(0, 5);
  const periodLabel = att ? `${MONTHS[att.month - 1]} ${att.year || year}` : `${MONTHS[month - 1]} ${year}`;
  const paidPct = c && c.daysInMonth ? Math.max(0, Math.min(100, Math.round((c.paidDays / c.daysInMonth) * 100))) : 0;

  return (
    <div>
      <PageHeader title="Hikes">
        {slip && (
          <span className={`hk-slip is-${String(slip.status).toLowerCase()}`}>
            <FiFileText size={13} /> {MONTHS[att.month - 1]} payslip · {slip.status} · {inr(slip.netPay)}
          </span>
        )}
      </PageHeader>

      {/* Who and which month */}
      <div className="pb-toolbar hk-toolbar">
        <div className="hk-pick">
          <SearchableSelect value={employee} onChange={(e) => { setEmployee(e.target.value); load(e.target.value); }}
            className="prm-input block w-full">
            {peopleOptions(employees, (p) => `${fullName(p.user)} (${p.employeeCode || '-'})`, { keep: [employee] })}
          </SearchableSelect>
        </div>
        <div className="hk-period">
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="prm-input" aria-label="Month">
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="prm-input" aria-label="Year">
            {Array.from({ length: 4 }, (_, i) => now.getFullYear() + 1 - i).map((y) => <option key={y}>{y}</option>)}
          </select>
          <button type="button" onClick={() => load()} disabled={loading || !employee}
            className="trn-btn is-primary accent-bg text-white hk-ok">
            {loading ? <FiRefreshCw size={14} className="animate-spin" /> : <FiCheck size={15} />} OK
          </button>
        </div>
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Every salary change waiting for a CEO/MD — theirs to approve, HR's to
          follow (and withdraw their own). The selected employee's is on their
          card below instead, so it is not listed twice. */}
      <SalaryChangeInbox
        hideWhenEmpty
        className="mb-4 hk-card"
        title="Salary changes waiting for approval"
        excludeEmployee={employee}
        reloadKey={changesKey}
        onOpen={(r) => {
          const id = r.employee?._id;
          if (id) { setEmployee(id); load(id); }
        }}
        onChanged={() => { changesMoved(); load(); }}
      />

      {!att && loading && (
        <div className="space-y-3">
          <div className="skeleton h-32 rounded-2xl" />
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="skeleton h-72 rounded-2xl" />
            <div className="skeleton h-72 rounded-2xl" />
          </div>
        </div>
      )}

      {att && c && (
        <div className={loading ? 'hk-stale' : undefined}>
          {/* The person and what they are paid now */}
          <section className="hk-hero">
            <div className="hk-who">
              <PersonAvatar user={run.employee.user} size="lg" />
              <div className="min-w-0">
                <h2 className="hk-name">{fullName(run.employee.user)}</h2>
                <div className="hk-meta">
                  {[run.employee.employeeCode, run.employee.designation, run.employee.department].filter(Boolean).join(' · ') || '—'}
                </div>
                {structureObj?.name && <span className="hk-chip"><FiLayers size={12} /> {structureObj.name}</span>}
              </div>
            </div>
            <div className="hk-ctc">
              <span className="hk-ctc-label">Annual CTC</span>
              <span className="hk-ctc-value">{savedCtc ? inr(savedCtc) : '—'}</span>
              <span className="hk-ctc-sub">{savedCtc ? `${inr(Math.round(savedCtc / 12))} / month` : 'Not set up'}</span>
            </div>
            <div className="hk-hero-actions">
              <button type="button" onClick={openHike} disabled={busy || !canRevise || heldByPending}
                title={!canRevise ? NO_MANAGER_SALARY
                  : heldByPending ? HELD
                    : approvalRequired ? "Revise this employee's CTC — goes to a CEO/MD for approval" : "Revise this employee's CTC (increment)"}
                className="trn-btn is-lg hk-revise">
                <FiTrendingUp size={16} /> Revise salary
              </button>
              {approvalRequired && canRevise && salarySaved && !pendingChange && (
                <span className="hk-approval"><FiShield size={12} /> Needs CEO/MD approval</span>
              )}
            </div>
          </section>

          {/* This employee's change waiting for a CEO/MD, with what the viewer
              may do about it (approve / turn down, or withdraw). */}
          <SalaryChangeInbox
            employee={employee}
            hideWhenEmpty
            className="mb-4 hk-card hk-pending"
            reloadKey={`${changesKey}:${employee}`}
            onChanged={() => { changesMoved(); load(); }}
          />

          <div className="hk-grid">
            <div className="hk-col">
              {/* Structure + CTC */}
              <section className="hk-card">
                <header className="hk-card-head">
                  <h3 className="hk-card-title"><FiSliders size={15} /> Salary setup</h3>
                </header>
                <div className="hk-setup">
                  <label className="block min-w-0">
                    <span className="prm-label">Salary structure</span>
                    <SearchableSelect value={setup.salaryStructure} onChange={(e) => setSetup({ ...setup, salaryStructure: e.target.value })}
                      className="prm-input block w-full">
                      <option value="">Select…</option>
                      {structures.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
                    </SearchableSelect>
                  </label>
                  <label className="block min-w-0">
                    <span className="prm-label">Annual CTC (₹)</span>
                    <input type="number" min="0" value={setup.annualCtc}
                      onChange={(e) => setSetup({ ...setup, annualCtc: e.target.value })}
                      className="prm-input hk-num" />
                  </label>
                  <button type="button" onClick={saveSetup} disabled={busy || !canRevise || heldByPending}
                    title={!canRevise ? NO_MANAGER_SALARY
                      : heldByPending ? HELD
                        : saveNeedsApproval ? 'This salary is saved — the change goes to a CEO/MD for approval' : undefined}
                    className="trn-btn hk-save">
                    {saveNeedsApproval ? 'Send for approval' : 'Save'}
                  </button>
                </div>
                {monthlySplit.length > 0 && (
                  <div className="hk-split">
                    <div className="hk-split-head">
                      <span>Monthly split</span>
                      <span>{inr(Math.round(savedCtc / 12))}</span>
                    </div>
                    <div className="hk-split-grid">
                      {monthlySplit.map((r) => (
                        <div key={r.label} className="hk-split-cell">
                          <span className="hk-split-label">{r.label}</span>
                          <span className="hk-split-value">{inr(r.amount)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              {/* Revision timeline */}
              <section className="hk-card">
                <header className="hk-card-head">
                  <h3 className="hk-card-title"><FiClock size={15} /> CTC revisions</h3>
                  <span className="hk-count">{revisions.length}</span>
                </header>
                {revisions.length === 0 ? (
                  <div className="hk-empty">No revisions yet</div>
                ) : (
                  <ol className="hk-timeline">
                    {shownRevisions.map((h, i) => {
                      const up = (h.newCtc || 0) >= (h.previousCtc || 0);
                      const pct = h.previousCtc > 0 ? Math.round(((h.newCtc - h.previousCtc) / h.previousCtc) * 1000) / 10 : null;
                      const hasLetter = h._id && h.previousCtc > 0 && h.newCtc > 0 && h.previousCtc !== h.newCtc;
                      return (
                        <li key={h._id || i} className={`hk-rev ${up ? 'is-up' : 'is-down'}`}>
                          <span className="hk-rev-dot" aria-hidden="true">
                            {up ? <FiArrowUpRight size={13} /> : <FiArrowDownRight size={13} />}
                          </span>
                          <div className="hk-rev-body">
                            <div className="hk-rev-top">
                              <span className="hk-rev-when">{MONTHS[(h.effectiveMonth || 1) - 1]} {h.effectiveYear}</span>
                              {pct !== null && pct !== 0 && (
                                <span className="hk-rev-pct">{pct > 0 ? '+' : ''}{pct}%</span>
                              )}
                            </div>
                            <div className="hk-rev-amt">
                              <span className="hk-rev-old">{inr(h.previousCtc)}</span>
                              <FiArrowRight size={12} className="opacity-50" />
                              <span className="hk-rev-new">{inr(h.newCtc)}</span>
                            </div>
                            {h.reason && <div className="hk-rev-reason" title={h.reason}>{h.reason}</div>}
                            <div className="hk-rev-foot">
                              <span className="hk-rev-by">
                                {h.byName || ''}
                                {/* Revisions that went through the CEO/MD step say who agreed. */}
                                {h.approvedByName && <> · approved by {h.approvedByName}</>}
                              </span>
                              {/* The increment (or salary revision) letter the employee was mailed. */}
                              {hasLetter && (
                                <button type="button" className="hk-letter"
                                  onClick={() => openProtectedPdf(`/payroll/employees/${run.employee._id}/ctc-history/${h._id}/letter.pdf`, 'Could not open the letter')
                                    .catch((err) => toast.error(err.message))}
                                  title={up ? 'Increment letter (PDF)' : 'Revision letter (PDF)'}>
                                  <FiFileText size={12} /> Letter
                                </button>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
                {revisions.length > 5 && (
                  <button type="button" className="hk-more" onClick={() => setShowAllRevisions((v) => !v)}>
                    {showAllRevisions ? 'Show fewer' : `Show all ${revisions.length}`}
                  </button>
                )}
              </section>
            </div>

            {/* The month behind the decision — context, not an editing surface */}
            <section className="hk-card hk-month">
              <header className="hk-card-head">
                <h3 className="hk-card-title"><FiCalendar size={15} /> {periodLabel}</h3>
              </header>

              <div className="hk-paid">
                <div className="hk-paid-top">
                  <span className="hk-paid-label">Paid days</span>
                  <span className="hk-paid-value">{c.paidDays}<span> / {c.daysInMonth}</span></span>
                </div>
                <div className="hk-bar" role="progressbar" aria-valuenow={paidPct} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${paidPct}%` }} />
                </div>
              </div>

              <div className="hk-tiles">
                <Stat label="LOP days" value={c.lopDays} warn={c.lopDays > 0} />
                {c.notEmployedDays > 0 && (
                  <Stat label="On payroll" value={`${c.eligibleDays} / ${c.daysInMonth}`} warn />
                )}
                <Stat label="Present" value={c.counts.present} />
                <Stat label="Half days" value={c.counts.halfDay} />
                <Stat label={`Leave (of ${c.policy?.paidLeaveQuota ?? 2})`} value={c.counts.onLeave} warn={c.policy?.excessLeave > 0} />
                <Stat label="Absent" value={c.counts.absent} warn={c.counts.absent > 0} />
                <Stat label="No-punch (LOP)" value={c.counts.noPunchAbsent ?? 0} warn={(c.counts.noPunchAbsent ?? 0) > 0} />
              </div>

              {c.policy && (
                <>
                  <h4 className="hk-sub">Attendance policy</h4>
                  <dl className="hk-rows">
                    <Row label={`Late arrivals (of ${c.policy.lateAllowance})`} value={c.policy.lateDays} warn={c.policy.excessLate > 0} />
                    <Row label="Excess late" value={c.policy.excessLate} warn={c.policy.excessLate > 0} />
                    <Row label="Excess leave" value={c.policy.excessLeave} warn={c.policy.excessLeave > 0} />
                    <Row label="No-punch days" value={c.policy.noPunchDays ?? 0} warn={(c.policy.noPunchDays ?? 0) > 0} />
                    <Row label="Duty days (2×)" value={c.policy.doublePayDays ?? 0} />
                    {(c.policy.pendingDoublePayDays ?? 0) > 0 && (
                      <Row label="Duty awaiting approval" value={c.policy.pendingDoublePayDays} warn />
                    )}
                  </dl>
                </>
              )}
              {c.hours && (
                <>
                  <h4 className="hk-sub">Working hours</h4>
                  <dl className="hk-rows">
                    <Row label="Days present" value={`${c.hours.daysPresent} days`} />
                    <Row label="Avg working hours" value={`${c.hours.avgHours} hrs`} />
                    <Row label="Comp-off earned" value={c.hours.compOff} warn={c.hours.compOff > 0} />
                  </dl>
                </>
              )}
            </section>
          </div>
        </div>
      )}

      {/* Revise salary */}
      {hike && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="min-w-0">
                <h2 className="card-title">Revise salary</h2>
                <div className="text-xs text-gray-500 mt-0.5">{fullName(run?.employee?.user)} · now {inr(setup.annualCtc)}/yr</div>
              </div>
              <button type="button" onClick={() => setHike(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            {approvalRequired && (
              <div className="hk-approval is-block mb-4"><FiShield size={12} /> Needs CEO/MD approval</div>
            )}
            <form onSubmit={submitHike} className="space-y-3.5">
              {/* Up or down. A separate toggle rather than expecting a minus
                  sign in the amount — typing "-5000" is easy to do by accident
                  and easy to misread on the way back out. */}
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div>
                  <span className="prm-label">Revision type</span>
                  <div className="trn-seg hk-seg" role="tablist" aria-label="Revision type">
                    {[['percent', '%'], ['amount', '₹'], ['set', 'Set to']].map(([v, label]) => (
                      <button key={v} type="button" role="tab" aria-selected={hike.mode === v}
                        onClick={() => setHike({ ...hike, mode: v })}
                        className={`trn-seg-btn${hike.mode === v ? ' is-on' : ''}`}>{label}</button>
                    ))}
                  </div>
                </div>
                {hike.mode !== 'set' && (
                  <div>
                    <span className="prm-label">Direction</span>
                    <div className="trn-seg hk-seg" role="tablist" aria-label="Direction">
                      {[['increase', 'Increase'], ['decrease', 'Decrease']].map(([v, label]) => (
                        <button key={v} type="button" role="tab" aria-selected={hike.direction === v}
                          onClick={() => setHike({ ...hike, direction: v })}
                          className={`trn-seg-btn hk-dir-${v}${hike.direction === v ? ' is-on' : ''}`}>{label}</button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <label className="block">
                <span className="prm-label">
                  {hike.mode === 'percent' ? 'Percent (%)'
                    : hike.mode === 'amount'
                      ? `${hike.direction === 'decrease' ? 'Decrease' : 'Increase'} (₹/yr)`
                      : 'New CTC (₹/yr)'}
                </span>
                <input type="number" min="0" required value={hike.value} autoFocus
                  onChange={(e) => setHike({ ...hike, value: e.target.value })}
                  className="prm-input hk-num hk-big" />
              </label>

              {/* Stacked on a phone: a half-width select has no room left for
                  "September" at the 16px the phone forces on form controls. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="prm-label">Effective month</span>
                  <select value={hike.effectiveMonth} onChange={(e) => setHike({ ...hike, effectiveMonth: Number(e.target.value) })}
                    className="prm-input">
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="prm-label">Effective year</span>
                  <input type="number" value={hike.effectiveYear}
                    onChange={(e) => setHike({ ...hike, effectiveYear: Number(e.target.value) })}
                    className="prm-input" />
                </label>
              </div>

              <label className="block">
                <span className="prm-label">Salary structure</span>
                <SearchableSelect value={hike.newStructure} onChange={(e) => setHike({ ...hike, newStructure: e.target.value })}
                  className="prm-input block w-full">
                  <option value="">Keep current structure</option>
                  {structures.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
                </SearchableSelect>
              </label>

              <label className="block">
                <span className="prm-label">Reason</span>
                <input value={hike.reason} onChange={(e) => setHike({ ...hike, reason: e.target.value })}
                  placeholder="e.g. Annual appraisal 2026" className="prm-input" />
              </label>

              {(() => {
                const cur = Number(setup.annualCtc) || 0;
                const down = hikePreviewCtc < cur;
                const pct = cur > 0 ? Math.round((hikePreviewCtc / cur - 1) * 1000) / 10 : 0;
                return (
                  <div className={`hk-preview ${down ? 'is-down' : 'is-up'}`}>
                    <div className="min-w-0">
                      <span className="hk-preview-label">New CTC</span>
                      <span className="hk-preview-value">{inr(hikePreviewCtc)}</span>
                      <span className="hk-preview-sub">{inr(Math.round(hikePreviewCtc / 12))} / month</span>
                    </div>
                    {cur > 0 && hikePreviewCtc !== cur && (
                      <span className="hk-preview-pct">
                        {down ? <FiArrowDownRight size={14} /> : <FiArrowUpRight size={14} />}
                        {pct > 0 ? '+' : ''}{pct}%
                      </span>
                    )}
                  </div>
                );
              })()}

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setHike(null)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={busy} className="trn-btn is-primary accent-bg text-white">
                  {approvalRequired
                    ? (busy ? 'Sending…' : 'Send for approval')
                    : (busy ? 'Applying…' : 'Apply')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Small labelled tile (red value when `warn`) in the month card.
function Stat({ label, value, warn }) {
  return (
    <div className={`hk-tile${warn ? ' is-warn' : ''}`}>
      <span className="hk-tile-value">{value}</span>
      <span className="hk-tile-label">{label}</span>
    </div>
  );
}

// One label → value line in the month card's policy / hours lists.
function Row({ label, value, warn }) {
  return (
    <div className={`hk-row${warn ? ' is-warn' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
